/**
 * @description   A Connection represents a single connection to a Signal K server.
 *                It manages both the HTTP connection (REST API) and the WS connection.
 * @author        Fabian Tollenaar <fabian@decipher.industries>
 * @copyright     2018-2019, Fabian Tollenaar. All rights reserved.
 * @license       Apache-2.0
 * @module        @signalk/signalk-js-sdk
 */

import EventEmitter from 'eventemitter3'
import WebSocket from 'isomorphic-ws'
import fetch from 'cross-fetch'
import Debug from 'debug'

const debug = Debug('signalk-js-sdk/Connection')

export default class Connection extends EventEmitter {
  constructor (options) {
    super()
    this.options = options
    this.httpURI = this.buildURI('http')
    this.wsURI = this.buildURI('ws')
    this.shouldDisconnect = false
    this.connected = false
    this.socket = null
    this.lastMessage = -1
    this.isConnecting = false
    
    this._fetchReady = false
    this._bearerTokenPrefix = this.options.bearerTokenPrefix || 'Bearer'
    this._authenticated = false
    this._retries = 0
    this._connection = null
    this._self = ''

    this.onWSMessage = this._onWSMessage.bind(this)
    this.onWSOpen = this._onWSOpen.bind(this)
    this.onWSClose = this._onWSClose.bind(this)
    this.onWSError = this._onWSError.bind(this)

    this._token = {
      kind: '',
      token: ''
    }

    this.reconnect(true)
  }

  set self (data) {
    if (data !== null) {
      this.emit('self', data)
    }

    this._self = data
  }

  get self () {
    return this._self
  }

  set connectionInfo (data) {
    if (data !== null) {
      this.emit('connectionInfo', data)
    }

    this._connection = data
    this.self = data.self
  }

  get connectionInfo () {
    return this._connection
  }

  buildURI (protocol) {
    let uri = this.options.useTLS === true ? `${protocol}s://` : `${protocol}://`
    uri += this.options.hostname
    uri += this.options.port === 80 ? '' : `:${this.options.port}`

    uri += '/signalk/'
    uri += this.options.version

    if (protocol === 'ws') {
      uri += '/stream?subscribe=none'
    }

    if (protocol === 'http') {
      uri += '/api'
    }

    return uri
  }

  state () {
    return {
      connecting: this.isConnecting,
      connected: this.connected,
      ready: this.fetchReady
    }
  }

  disconnect () {
    debug('[disconnect] called')
    this.shouldDisconnect = true
    this.reconnect()
  }

  reconnect (initial = false) {
    if (this.isConnecting === true) {
      return
    }

    if (this.socket !== null) {
      debug('[reconnect] closing socket')
      this.socket.close()
      return
    }

    if (initial !== true && this._retries === this.options.maxRetries) {
      this.emit('hitMaxRetries')
      this.cleanupListeners()
      return
    }

    if (initial !== true && this.options.reconnect === false) {
      debug('[reconnect] Not reconnecting, for reconnect is false')
      this.cleanupListeners()
      return
    }

    if (initial !== true && this.shouldDisconnect === true) {
      debug('[reconnect] not reconnecting, shouldDisconnect is true')
      this.cleanupListeners()
      return
    }

    debug(`[reconnect] socket is ${this.socket === null ? '' : 'not '}NULL`)

    this._fetchReady = false
    this.shouldDisconnect = false
    this.isConnecting = true

    if (this.options.useAuthentication === false) {
      this._fetchReady = true
      this.emit('fetchReady')
      this.initiateSocket()
      return
    }

    const authRequest = {
      method: 'POST',
      mode: 'cors',
      credentials: 'same-origin',
      body: JSON.stringify({
        username: String(this.options.username || ''),
        password: String(this.options.password || '')
      })
    }

    this.fetch('/auth/login', authRequest)
      .then(result => {
        if (!result || typeof result !== 'object' || !result.hasOwnProperty('token')) {
          throw new Error(`Unexpected response from auth endpoint: ${JSON.stringify(result)}`)
        }

        debug(`[reconnect] successful auth request: ${JSON.stringify(result, null, 2)}`)
     
        this._authenticated = true
        this._token = {
          kind: (typeof result.type === 'string' && result.type.trim() !== '') ? result.type : this._bearerTokenPrefix,
          token: result.token
        }

        this._fetchReady = true
        this.emit('fetchReady')
        this.initiateSocket()
      })
      .catch(err => {
        this.emit('error', err)
        debug(`[reconnect] error logging in: ${err.message}`)
        throw err
      })
  }

  setAuthenticated (token, kind = 'JWT') { // @FIXME default type should be Bearer
    this.emit('fetchReady')
    this._authenticated = true
    this._token = {
      kind,
      token
    }
  }

  initiateSocket () {
    this.socket = new WebSocket(this.wsURI)
    this.socket.addEventListener('message', this.onWSMessage)
    this.socket.addEventListener('open', this.onWSOpen)
    this.socket.addEventListener('error', this.onWSError)
    this.socket.addEventListener('close', this.onWSClose)
  }

  cleanupListeners () {
    debug(`[cleanupListeners] resetting auth and removing listeners`)
    // Reset authentication
    this._authenticated = false
    this._token = {
      kind: '',
      token: ''
    }
    this.removeAllListeners()
  }

  _onWSMessage (evt) {
    this.lastMessage = Date.now()
    let data = evt.data

    try {
      if (typeof data === 'string') {
        data = JSON.parse(data)
      }
    } catch (e) {
      console.log(`[Connection: ${this.options.hostname}] Error parsing data: ${e.message}`)
    }

    if (data && typeof data === 'object' && data.hasOwnProperty('name') && data.hasOwnProperty('version') && data.hasOwnProperty('roles')) {
      this.connectionInfo = data
    }

    this.emit('message', data)
  }

  _onWSOpen () {
    this.connected = true
    this.isConnecting = false
    this.emit('connect')
  }

  _onWSError (err) {
    debug('[_onWSError] WS error', err.message || '')
    this._retries += 1
    this.emit('error', err)
    this.reconnect()
  }

  _onWSClose (evt) {
    debug('[_onWSClose] called with wsURI:', this.wsURI)
    this.socket.removeEventListener('message', this.onWSMessage)
    this.socket.removeEventListener('open', this.onWSOpen)
    this.socket.removeEventListener('error', this.onWSError)
    this.socket.removeEventListener('close', this.onWSClose)

    this.connected = false
    this.isConnecting = false
    this.socket = null
    this._retries += 1

    this.emit('disconnect', evt)
    this.reconnect()
  }

  send (data) {
    if (this.connected !== true || this.socket === null) {
      return Promise.reject(new Error('Not connected to WebSocket'))
    }

    // Basic check if data is stringified JSON
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch (e) {
        debug(`[send] data is string but not valid JSON: ${e.message}`)
      }
    }

    const isObj = (data && typeof data === 'object')

    // Add token to data IF authenticated
    // https://signalk.org/specification/1.3.0/doc/security.html#other-clients
    if (isObj && this.useAuthentication === true && this._authenticated === true) {
      data.token = String(this._token.token)
    }

    try {
      if (isObj) {
        data = JSON.stringify(data)
      }
    } catch (e) {
      return Promise.reject(e)
    }

    debug(`Sending data to socket: ${data}`)
    this.socket.send(data)
  }

  fetch (path, opts) {
    if (path.charAt(0) !== '/') {
      path = `/${path}`
    }

    if (!opts || typeof opts !== 'object') {
      opts = {
        method: 'GET'
      }
    }

    if (!opts.headers || typeof opts.headers !== 'object') {
      opts.headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    }

    if (this._authenticated === true && !path.includes('auth/login')) {
      opts.headers = {
        ...opts.headers,
        Authorization: `${this._token.kind} ${this._token.token}`
      }

      opts.credentials = 'same-origin'
      opts.mode = 'cors'

      debug(`[fetch] enriching fetch options with in-memory token`)
    }

    let URI = `${this.httpURI}${path}`

    // @TODO httpURI includes /api, which is not desirable. Need to refactor
    if (URI.includes('/api/auth/login')) {
      URI = URI.replace('/api/auth/login', '/auth/login')
    }

    // @TODO httpURI includes /api, which is not desirable. Need to refactor
    if (URI.includes('/api/access/requests')) {
      URI = URI.replace('/api/access/requests', '/access/requests')
    }

    // @FIXME weird hack because node server paths for access requests are not standardised
    if (URI.includes('/signalk/v1/api/security')) {
      URI = URI.replace('/signalk/v1/api/security', '/security')
    }

    debug(`[fetch] ${opts.method || 'GET'} ${URI} ${JSON.stringify(opts, null, 2)}`)
    return fetch(URI, opts)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Error fetching ${URI}: ${response.status} ${response.statusText}`)
        }

        const type = response.headers.get('content-type')

        if (type.includes('application/json')) {
          return response.json()
        }

        return response.text()
      })
  }
}