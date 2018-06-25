'use strict'

const PRIVATE_CHANNEL_INDEX = 7,
	PRIVATE_CHANNEL_ID = -2 >>> 0,
	PRIVATE_CHANNEL_NAME = 'Proxy',
	PUBLIC_ENABLE = true,
	PUBLIC_MATCH = /^!([^!].*)$/,
	LOGIN_MESSAGE = true

class Command {
	constructor(dispatch) {
		this.dispatch = dispatch

		this.loaded = false
		this.hooks = {}

		dispatch.hook('S_LOGIN', 'raw', () => { this.loaded = false })

		dispatch.hook('S_LOAD_CLIENT_USER_SETTING', 'raw', () => {
			if(!this.loaded && (this.loaded = true))
				process.nextTick(() => {
					dispatch.toClient('S_JOIN_PRIVATE_CHANNEL', 1, {
						index: PRIVATE_CHANNEL_INDEX,
						id: PRIVATE_CHANNEL_ID,
						unk: [],
						name: PRIVATE_CHANNEL_NAME
					})

					if(LOGIN_MESSAGE) this.message('TERA Proxy enabled. Client version: ' + this.dispatch.base.protocolVersion)
				})
		})

		dispatch.hook('S_JOIN_PRIVATE_CHANNEL', 1, event => event.index === PRIVATE_CHANNEL_INDEX ? false : undefined)
		dispatch.hook('C_LEAVE_PRIVATE_CHANNEL', 1, event => event.index === PRIVATE_CHANNEL_INDEX ? false : undefined)

		dispatch.hook('C_REQUEST_PRIVATE_CHANNEL_INFO', 1, event => {
			if(event.channelId === PRIVATE_CHANNEL_ID) {
				dispatch.toClient('S_REQUEST_PRIVATE_CHANNEL_INFO', 1, {
					owner: 1,
					password: 0,
					members: [],
					friends: []
				})
				return false
			}
		})

		let lastError = '',
			hookOverride = (name, version, cb) => {
				dispatch.hook(name, version, {order: -10}, cb)

				// Let other modules handle possible commands before we silence them
				dispatch.hook(name, version, {order: 10, filter: {silenced: null}}, event => {
					if(lastError) {
						if(!event.$silenced) this.message(lastError)
						lastError = ''
						return false
					}
				})
			},
			handleCommand = message => {
				try {
					var args = parseArgs(stripOuterHTML(message))
				}
				catch(e) {
					lastError = 'Syntax error: ' + e.message
					return
				}

				try {
					if(!this.exec(args)) {
						lastError = `Unknown command "${args[0]}".`
						return
					}
				}
				catch(e) {
					this.message('Error running callback for command "' + args[0] + '".')
					console.error(e)
				}

				lastError = ''
				return false
			}

		// /! commands
		hookOverride('C_OP_COMMAND', 1, event => handleCommand(event.command))

		hookOverride('C_CHAT', 1, event => {
			// Proxy channel
			if(event.channel === 11 + PRIVATE_CHANNEL_INDEX) return handleCommand(event.message)

			// Any channel with regex match
			if(PUBLIC_ENABLE) {
				const match = PUBLIC_MATCH.exec(stripOuterHTML(event.message))

				if(match) return handleCommand(match[1])
			}
		})

		// Whispers with regex match
		if(PUBLIC_ENABLE)
			hookOverride('C_WHISPER', 1, event => {
				const match = PUBLIC_MATCH.exec(stripOuterHTML(event.message))

				if(match) return handleCommand(match[1])
			})
	}

	exec(str) {
		const args = Array.isArray(str) ? str : parseArgs(str)

		if(args.length === 0) return false

		const cb = this.hooks[args[0].toLowerCase()]

		if(cb) {
			cb.call(...args)
			return true
		}

		return false
	}

	add(cmd, cb, ctx) {
		if(typeof cb === 'function') {
			if(ctx !== undefined) cb = cb.bind(ctx)
		}
		else if(typeof cb === 'object') cb = makeSubCommandHandler(cb, ctx)
		else throw new Error('Callback must be a function or object')

		if(Array.isArray(cmd)) {
			for(let c of cmd) this.add(c, cb)
			return
		}

		if(typeof cmd !== 'string') throw new Error('Command must be a string or array of strings')
		if(cmd === '') throw new Error('Command must not be an empty string')

		if(this.hooks[cmd = cmd.toLowerCase()]) throw new Error('Command already registered:', cmd)

		this.hooks[cmd] = cb
	}

	remove(cmd) {
		if(Array.isArray(cmd)) {
			for(let c of cmd) this.remove(c)
			return
		}

		if(typeof cmd !== 'string') throw new Error('Command must be a string or array of strings')
		if(cmd === '') throw new Error('Command must not be an empty string')

		delete this.hooks[cmd.toLowerCase()]
	}

	message(msg) {
		this.dispatch.toClient('S_PRIVATE_CHAT', 1, {
			channel: PRIVATE_CHANNEL_ID,
			authorID: 0,
			authorName: '',
			message: msg
		})
	}
}

function makeSubCommandHandler(_obj, ctx) {
	const obj = {}

	for(let cmd in _obj) {
		const cb = _obj[cmd]

		cmd = cmd.toLowerCase()

		if(typeof cb === 'function') obj[cmd] = ctx !== undefined ? cb.bind(ctx) : cb
		else if(typeof cb === 'object') obj[cmd] = makeSubCommandHandler(cb, ctx)
		else throw new Error('Sub-command callback must be a function or object')
	}

	return function subCommandHandler(cmd) {
		const cb = (cmd !== undefined ? obj[cmd.toLowerCase()] : obj.$none) || obj.$default

		if(cb) cb.call(...arguments)
	}
}

function stripOuterHTML(str) {
	return str.replace(/^<[^>]+>|<\/[^>]+><[^\/][^>]*>|<\/[^>]+>$/g, '')
}

function parseArgs(str) {
	const parseHTML = /.*?<\/.*?>/g,
		args = []

	let arg = '',
		quote = ''

	for(let i = 0, c = ''; i < str.length; i++) {
		c = str[i]

		switch(c) {
			case '<':
				parseHTML.lastIndex = i + 1

				let len = parseHTML.exec(str)

				if(!len) throw new Error('HTML parsing failure')

				len = len[0].length
				arg += str.substr(i, len + 1)
				i += len
				break
			case '\\':
				c = str[++i]

				if(c === undefined) throw new Error('Unexpected end of line')

				arg += c
				break
			case '\'':
			case '"':
				if(arg === '' && quote === '') {
					quote = c
					break
				}
				if(quote === c) {
					quote = ''
					break
				}
				arg += c
				break
			case ' ':
				if(quote === '') {
					if(arg !== '') {
						args.push(arg)
						arg = ''
					}
					break
				}
			default:
				arg += c
		}
	}

	if(arg !== '') {
		if(quote !== '') throw new Error('Expected ' + quote)

		args.push(arg)
	}

	return args
}

const map = new WeakMap()

module.exports = function Require(dispatch) {
	if(map.has(dispatch.base)) return map.get(dispatch.base)

	const instance = new Command(dispatch)
	map.set(dispatch.base, instance)
	return instance
}