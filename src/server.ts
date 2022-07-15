import { spawn, exec } from 'child_process'
import { statSync, mkdirSync } from 'fs'
import { join } from 'path'
import { cwd } from 'process'
import { PerformanceObserver } from 'perf_hooks'
import * as hostile from 'hostile'
import WebServer from '@/webServer'
import KcpServer from '@/kcpServer'
import GlobalState from '@/globalState'
import Logger from './logger'
import { cRGB } from './tty'
import DnsServer from './dnsServer'
import { waitMs } from '@/utils/asyncWait'
import { Announcement } from './types/announcement'
import config, { SUPPORT_VERSIONS } from './config'

const requiredDirs = [
  //dispatch
  'data/key/' + config.dispatchKeyId,

  // game resource
  'data/bin/' + config.version,
  'data/proto/' + config.version,
  'data/game/' + config.version,

  // log
  'data/log/server',
  'data/log/client',
  'data/log/dump',

  // user data
  'data/user',

  // windy
  'data/luac'
]

const welcomeAnnouncement: Announcement = {
  type: 2, // Game
  subtitle: 'Welcome',
  title: `Welcome to ${config.serverName}!`,
  banner: 'https://webstatic-sea.mihoyo.com/hk4e/announcement/img/banner/welcome.png',
  content: '<p style="white-space: pre-wrap;">Hello, have fun~~</p><img src="https://webstatic-sea.mihoyo.com/hk4e/announcement/img/fallen.png"><p style="white-space: pre-wrap;">Powered by: HuTao GS</p>',
  start: Date.now(),
  end: Date.now() + (365 * 24 * 60 * 60e3),
  tag: 3,
  loginAlert: true
}

const logger = new Logger('SERVER')

export default class Server {
  globalState: GlobalState

  observer: PerformanceObserver

  dnsServer: DnsServer
  webServer: WebServer
  kcpServer: KcpServer

  constructor() {
    // Window title
    logger.write(`\x1b]0;${config.serverName}\x07`)

    // Start log capture
    Logger.startCapture()

    // Server build info
    logger.info(`Name: ${cRGB(0xffffff, config.serverName)}`)
    logger.info(`Build: ${cRGB(0xffffff, process.env.NODE_ENV || 'development')}`)
    logger.info(`Game version: ${cRGB(0xffffff, config.version)}`)
    logger.info(`Log level: ${cRGB(0xffffff, logger.getLogLevel().toString())}`)

    if (!SUPPORT_VERSIONS.includes(config.version)) {
      logger.error('Unsupported version.')
      return
    }

    this.checkDirs()

    this.globalState = new GlobalState()
    this.globalState.load()

    this.observer = new PerformanceObserver(list => logger.performance(list))

    this.dnsServer = new DnsServer(this.globalState)
    this.webServer = new WebServer(this.globalState)
    this.kcpServer = new KcpServer(this.globalState)

    this.webServer.announcements.push(welcomeAnnouncement)
  }

  get announcements() {
    return this.webServer.announcements
  }

  flushDNS(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cp = exec('ipconfig /flushdns')
      cp.on('exit', () => resolve())
      cp.on('error', (err) => reject(err))
    })
  }

  async setHosts(): Promise<void> {
    if (!config.hosts) return

    logger.debug('Setting hosts...')

    for (let host of config.hosts) {
      for (let i = 1; i <= 10; i++) {
        try {
          hostile.set('127.0.0.1', host)
          break
        } catch (err) {
          // only throw error if all attempts failed
          if (i >= 10) {
            logger.error('Set hosts failed:', err)
            this.restart(15e3)
            return
          }
        }
      }
    }

    logger.debug('Set hosts success.')

    logger.debug('Flushing dns...')
    try {
      await this.flushDNS()
      logger.debug('Flush dns success.')
    } catch (err) {
      logger.error('Flush dns failed:', err)
      this.restart(15e3)
    }
  }

  async removeHosts(): Promise<void> {
    if (!config.hosts) return

    logger.debug('Removing hosts...')

    for (let host of config.hosts) {
      for (let i = 1; i <= 10; i++) {
        try {
          hostile.remove('127.0.0.1', host)
          break
        } catch (err) {
          // only throw error if all attempts failed
          if (i >= 10) {
            logger.error('Remove hosts failed:', err)
            this.restart(15e3)
            return
          }
        }
      }
    }

    logger.debug('Remove hosts success.')

    logger.debug('Flushing dns...')
    try {
      await this.flushDNS()
      logger.debug('Flush dns success.')
    } catch (err) {
      logger.error('Flush dns failed:', err)
      this.restart(15e3)
    }
  }

  async start(): Promise<void> {
    const { observer, dnsServer, webServer, kcpServer } = this

    observer.observe({ type: 'measure', buffered: true })

    Logger.mark('Start')

    logger.info('Starting...')

    await this.setHosts()

    let listening = 0

    async function onListening(): Promise<void> {
      if (++listening < 3) return

      logger.info('Started.')
      Logger.measure('Server start', 'Start')
    }

    dnsServer.on('listening', onListening)
    webServer.on('listening', onListening)
    kcpServer.on('listening', onListening)

    try {
      dnsServer.start()
      webServer.start([
        { port: config.httpPort },
        { port: config.httpsPort, useHttps: true },
        { port: config.recorderPort }
      ])
      kcpServer.start()
    } catch (err) {
      logger.error('Error while starting:', err)
    }
  }

  async restart(delay: number = 1e3): Promise<void> {
    logger.info('Restarting...', `Delay: ${delay}ms`)

    await this.runShutdownTasks()
    await waitMs(delay)

    process.argv[1] = `"${process.argv[1]}"`
    spawn(`"${process.argv0}"`, process.argv.slice(1), { detached: true, shell: true, stdio: 'ignore' }).unref()
    process.exit()
  }

  async stop(delay: number = 1e3): Promise<void> {
    logger.info('Stopping...', `Delay: ${delay}ms`)

    await this.runShutdownTasks(true)
    await waitMs(delay)

    process.exit()
  }

  async runShutdownTasks(fullShutdown: boolean = false) {
    const { globalState, observer, dnsServer, webServer, kcpServer } = this

    await kcpServer.stop()

    webServer.stop()
    dnsServer.stop()

    globalState.save()

    if (fullShutdown) {
      await this.removeHosts()
    }

    observer.disconnect()

    await Logger.stopCapture(!!globalState.get('SaveLog'))
  }

  setLogLevel(level: number) {
    logger.setLogLevel(level)
  }

  checkDirs() {
    for (let path of requiredDirs) {
      try { if (statSync(join(cwd(), path))) continue } catch (err) { }
      try {
        logger.info('Creating directory:', path)
        mkdirSync(join(cwd(), path), { recursive: true })
      } catch (err) {
        logger.error(err)
      }
    }
  }
}