import { spawn } from 'child_process'
import { get } from 'https'
import { join } from 'path'
import { cwd } from 'process'
import config from './config'
import Logger from './logger'
import Server from './server'
import { UpdateApiRetcodeEnum } from './types/enum'
import { UpdateApiResponse, UpdateContent } from './types/update'
import { deleteFile, readFile, writeFile } from './utils/fileSystem'
import OpenSSL, { Key, KeyPair } from './utils/openssl'
import parseArgs from './utils/parseArgs'
import { rsaSign, rsaVerify } from './utils/rsa'
import { stringXorDecode, stringXorEncode } from './utils/xor'

enum UpdateStateEnum {
  START = 0, // download new exe
  CLONE = 1, // switch to new exe & replace old exe with new one
  CLEAN = 2  // switch to cloned exe & delete downloaded exe
}

interface PkgProcess extends NodeJS.Process {
  pkg?: {
    entrypoint: string
    defaultEntrypoint: string
  }
}

const { updateURL } = config
const proc: PkgProcess = process
const logger = new Logger('UPDATE', 0x96ffc7)

export default class Update {
  server: Server

  constructor(server: Server) {
    this.server = server
  }

  private async stopServer() {
    await this.server.runShutdownTasks(true)
  }

  private async getKeyPair(): Promise<KeyPair> {
    return OpenSSL.getKeyPair(join(cwd(), 'data/key'), 'update', 4096)
  }

  private async getPublicKey(): Promise<Key> {
    return OpenSSL.getPublicKey(join(cwd(), 'data/key'), 'update')
  }

  private async decodeContent(content: UpdateContent): Promise<Buffer> {
    const { v, c, s } = content
    if (v == null || c == null || s == null) throw new Error('Invalid content data')

    const contentBuf = Buffer.from(c, 'base64')
    const signBuf = Buffer.from(s, 'base64')

    const decoded = <Buffer>stringXorDecode(contentBuf, contentBuf[contentBuf.length - 1] ^ (v & 0xFF), true)
    const publicKey = await this.getPublicKey()
    const isValid = rsaVerify(publicKey.pem, decoded, signBuf)

    if (isValid !== true) throw new Error('Invalid signature')

    return decoded
  }

  private apiVersion(url: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      get(`${url}/version`, res => {
        const { statusCode } = res
        if (statusCode !== 200) {
          // Consume response data to free up memory
          res.resume()

          return reject(`HTTP ${statusCode}`)
        }

        let resData = ''

        res.setEncoding('utf8')
        res.on('error', err => reject(`Error: ${err.message}`))
        res.on('data', chunk => resData += chunk)
        res.on('end', async () => {
          try {
            const rsp: UpdateApiResponse = JSON.parse(resData)
            if (rsp == null) throw new Error('Invalid json')

            const { code, msg, data } = rsp
            if (code !== UpdateApiRetcodeEnum.SUCC) throw new Error(msg || 'Unknown error')
            if (data == null) throw new Error('data is null')

            resolve((<UpdateContent>data).v)
          } catch (err) {
            reject(err)
          }
        })
      }).on('error', err => reject(`Error: ${err.message}`))
    })
  }

  private apiGetContent(url: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      get(`${url}/get`, res => {
        const { statusCode } = res
        if (statusCode !== 200) {
          // Consume response data to free up memory
          res.resume()

          return reject(`HTTP ${statusCode}`)
        }

        let resData = ''

        res.setEncoding('utf8')
        res.on('error', err => reject(`Error: ${err.message}`))
        res.on('data', chunk => resData += chunk)
        res.on('end', async () => {
          try {
            const rsp: UpdateApiResponse = JSON.parse(resData)
            if (rsp == null) throw new Error('Invalid json')

            const { code, msg, data } = rsp
            if (code !== UpdateApiRetcodeEnum.SUCC) throw new Error(msg || 'Unknown error')
            if (data == null) throw new Error('data is null')

            resolve(await this.decodeContent(<UpdateContent>data))
          } catch (err) {
            reject(err)
          }
        })
      }).on('error', err => reject(`Error: ${err.message}`))
    })
  }

  getBuildVersion(): number {
    if (proc.pkg == null) return null
    if (parseArgs(proc.argv).dev) return 1
    return parseInt(process.env.COMMIT_HASH, 16) || null
  }

  async getBuildContent(): Promise<UpdateContent> {
    if (proc.pkg == null) return null

    const buildVersion = this.getBuildVersion()
    const exeFile = await readFile(proc.execPath)
    const encodedContent = stringXorEncode(exeFile, buildVersion & 0xFF)
    const contentSign = rsaSign((await this.getKeyPair()).private.pem, exeFile)

    return {
      v: buildVersion,
      c: encodedContent.toString('base64'),
      s: contentSign.toString('base64')
    }
  }

  async start() {
    try {
      if (proc.pkg == null) return logger.error('Not executable, cannot update.')

      const args = parseArgs(proc.argv)
      const updateState = args.updateState || UpdateStateEnum.START
      switch (updateState) {
        case UpdateStateEnum.START: {
          if (updateURL == null) return logger.error('No update url.')

          logger.info('Comparing version...')
          if ((await this.apiVersion(updateURL)) === this.getBuildVersion()) return logger.info('Same version, stop update.')

          logger.info('Mismatch version, downloading update...')
          const newExePath = join(cwd(), 'Update.exe')
          const newExeFile = await this.apiGetContent(updateURL)
          await writeFile(newExePath, newExeFile)

          logger.info('Stopping...')
          await this.stopServer()

          logger.info('Starting update exe...')
          spawn(
            `"${newExePath}"`,
            [
              proc.argv[1],
              `-updateState=${UpdateStateEnum.CLONE}`,
              `-oldPath="${proc.execPath}"`
            ],
            { detached: true, shell: true, stdio: 'ignore' }
          ).on('spawn', () => {
            logger.info('Exiting...')
            proc.exit()
          }).unref()
          break
        }
        case UpdateStateEnum.CLONE: {
          const oldExePath = args.oldPath?.toString()
          if (oldExePath == null) return logger.error('Missing argument')

          logger.info('Copying exe...')
          const newExePath = proc.execPath
          const newExeFile = await readFile(newExePath)
          await writeFile(oldExePath, newExeFile)

          logger.info('Stopping...')
          await this.stopServer()

          logger.info('Starting exe...')
          spawn(
            `"${oldExePath}"`,
            [
              proc.argv[1],
              `-updateState=${UpdateStateEnum.CLEAN}`,
              `-updatePath="${newExePath}"`
            ],
            { detached: true, shell: true, stdio: 'ignore' }
          ).on('spawn', () => {
            logger.info('Exiting...')
            proc.exit()
          }).unref()
          break
        }
        case UpdateStateEnum.CLEAN: {
          logger.info('Cleaning up...')
          const updateExePath = args.updatePath?.toString()
          if (updateExePath == null) return logger.error('Missing argument')

          await deleteFile(updateExePath)

          logger.info('Update complete.')
          break
        }
        default: {
          logger.error('Invalid update state: ' + updateState)
        }
      }
    } catch (err) {
      logger.error((<Error>err).message)
    }
  }
}