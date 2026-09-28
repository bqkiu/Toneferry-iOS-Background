const btnStart = document.getElementById('btnStart')
const btnStop = document.getElementById('btnStop')
const btnReclaim = document.getElementById('btnReclaim')
// PATCH: toggle for the AirPods auto-reclaim behaviour (persisted)
function updateReclaimBtn() {
  if (btnReclaim) {
    btnReclaim.textContent = autoReclaimEnabled()
      ? '被抢后自动抢回：开（会抢断手机）'
      : '被抢后自动抢回：关'
  }
}
if (btnReclaim) {
  btnReclaim.addEventListener('click', () => {
    try {
      localStorage.setItem('autoReclaimMode', autoReclaimEnabled() ? 'off' : 'on')
    } catch {
      /* ignore */
    }
    updateReclaimBtn()
  })
  updateReclaimBtn()
}
const statusDot = document.getElementById('statusDot')
const statusText = document.getElementById('statusText')
const sampleRateEl = document.getElementById('sampleRate')
const channelsEl = document.getElementById('channels')
const bufferedEl = document.getElementById('buffered')
const levelEl = document.getElementById('level')

/** @type {AudioContext | null} */
let audioContext = null
/** @type {AudioWorkletNode | ScriptProcessorNode | null} */
let player = null
/** @type {'worklet' | 'script' | null} */
let playerMode = null
/** @type {WebSocket | null} */
let ws = null
/** @type {{ sampleRate: number, channels: number, format: string } | null} */
let config = null
/** User intends to keep listening (until Stop). */
let listening = false
/** Page is hidden / screen off — WS closed on purpose, wait for foreground. */
let backgroundPaused = false
/** @type {HTMLAudioElement | null} */
let keepAliveAudio = null
/** Live-stream tap: WebAudio output routed through a MediaStream so iOS
 * treats the page as a live broadcast — the only web audio type allowed to
 * keep playing while the screen is off (verified by ambiph.one et al.). */
/** @type {MediaStreamAudioDestinationNode | null} */
let streamDest = null
/** @type {HTMLAudioElement | null} */
let streamAudio = null
const NoSleepCtor = typeof window !== 'undefined' ? window.NoSleep : undefined
const noSleep = typeof NoSleepCtor === 'function' ? new NoSleepCtor() : null
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null
let reconnectAttempt = 0
/** Dim UI and skip meter DOM updates after idle listening. */
let powerSave = false
/** @type {ReturnType<typeof setTimeout> | null} */
let powerSaveTimer = null
const POWER_SAVE_DELAY_MS = 30_000

const scriptQueue = {
  samples: new Float32Array(0),
  clear() {
    this.samples = new Float32Array(0)
  },
  push(buf) {
    const next = new Float32Array(this.samples.length + buf.length)
    next.set(this.samples)
    next.set(buf, this.samples.length)
    const max = 48000 * 2
    this.samples = next.length > max ? next.subarray(next.length - max) : next
  },
  pull(frames) {
    const need = frames * 2
    const out = new Float32Array(need)
    const take = Math.min(need, this.samples.length)
    out.set(this.samples.subarray(0, take))
    this.samples = this.samples.subarray(take)
    return out
  },
  frames() {
    return this.samples.length >> 1
  },
}

function setStatsEnabled(enabled) {
  if (playerMode === 'worklet' && player) {
    try {
      player.port.postMessage({ type: 'stats-enable', enabled })
    } catch {
      /* ignore */
    }
  }
}

function enterPowerSave() {
  if (!listening || powerSave) return
  powerSave = true
  document.documentElement.classList.add('power-save')
  setStatsEnabled(false)
}

function exitPowerSave() {
  if (!powerSave) return
  powerSave = false
  document.documentElement.classList.remove('power-save')
  setStatsEnabled(true)
}

function clearPowerSaveTimer() {
  if (powerSaveTimer) {
    clearTimeout(powerSaveTimer)
    powerSaveTimer = null
  }
}

function schedulePowerSave() {
  clearPowerSaveTimer()
  if (!listening) return
  powerSaveTimer = setTimeout(() => {
    powerSaveTimer = null
    enterPowerSave()
  }, POWER_SAVE_DELAY_MS)
}

function bumpIdle() {
  if (!listening) return
  exitPowerSave()
  schedulePowerSave()
}

function setStatus(text, ok = false) {
  statusText.textContent = text
  statusDot.classList.toggle('on', ok)
}

function playingLabel() {
  return playerMode === 'worklet' ? '播放中' : '播放中（兼容模式）'
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/audio`
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  // Do not reconnect while page is in background / screen off
  if (!listening || backgroundPaused || document.hidden || reconnectTimer) return
  const delay = Math.min(8000, 500 * 2 ** reconnectAttempt)
  reconnectAttempt += 1
  setStatus(`连接断开，${Math.round(delay / 1000)}s 后重连…`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!listening || backgroundPaused || document.hidden) return
    connectWs()
  }, delay)
}

/** Intentionally drop WS when tab backgrounds or screen locks. */
function pauseForBackground() {
  if (!listening) return
  backgroundPaused = true
  clearReconnect()

  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }

  if (playerMode === 'worklet' && player) {
    try {
      player.port.postMessage({ type: 'reset' })
    } catch {
      /* ignore */
    }
  }
  scriptQueue.clear()

  if (audioContext && audioContext.state === 'running') {
    audioContext.suspend().catch(() => {})
  }

  setStatus('已暂停（后台 / 息屏）')
}

/** Tiny silent WAV — marks page as "media playing" on many Android browsers. */
function silentWavDataUri(seconds = 2, sampleRate = 8000) {
  const n = sampleRate * seconds
  const dataBytes = n * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  w(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, dataBytes, true)
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:audio/wav;base64,${btoa(bin)}`
}

async function startKeepAliveMedia() {
  if (!keepAliveAudio) {
    // PATCH: use a real-file silent WAV instead of data URI —
    // iOS Safari treats it as a genuine media session (Now Playing),
    // which keeps the page alive and AudioWorklet running in background.
    keepAliveAudio = new Audio('/silence.wav')
    keepAliveAudio.loop = true
    keepAliveAudio.volume = 0.01
    keepAliveAudio.setAttribute('playsinline', '')
    keepAliveAudio.setAttribute('webkit-playsinline', '')
    // on* property — dedupes across start/stop cycles
    keepAliveAudio.onpause = resumeInterruptedAudio
  }
  try {
    await keepAliveAudio.play()
  } catch (err) {
    console.warn('keepalive audio play failed', err)
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: '系统音频推流',
        artist: 'Toneferry',
        album: 'Loopback',
      })
      navigator.mediaSession.playbackState = 'playing'
      navigator.mediaSession.setActionHandler('pause', () => {
        stop().catch(console.error)
      })
      navigator.mediaSession.setActionHandler('stop', () => {
        stop().catch(console.error)
      })
      navigator.mediaSession.setActionHandler('play', () => {
        if (!listening) start().catch(console.error)
        else resumeInterruptedAudio(true)
      })
    } catch {
      /* ignore unsupported handlers */
    }
  }
}

function stopKeepAliveMedia() {
  if (keepAliveAudio) {
    keepAliveAudio.pause()
    keepAliveAudio.currentTime = 0
  }
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'none'
    } catch {
      /* ignore */
    }
  }
}

/** iOS 16.4+: mark the page's audio session as real media playback
 * (upgrades it from the "ambient"/ringer session). */
function enablePlaybackSession() {
  try {
    if ('audioSession' in navigator) {
      navigator.audioSession.type = 'playback'
      // PATCH(v5): session returning to 'active' only means the interruption
      // ENDED (e.g. the phone just took the AirPods and the route settled).
      // Resuming playback here would STEAL the AirPods back — only recompute
      // routing; element playback is left to user gesture or the opt-in
      // reclaim toggle inside resumeInterruptedAudio.
      navigator.audioSession.addEventListener?.('statechange', () => {
        try {
          if (navigator.audioSession.state === 'active') {
            applyAudioRoute()
          }
        } catch {
          /* ignore */
        }
      })
    }
  } catch {
    /* ignore unsupported */
  }
}

/** Route WebAudio output through an <audio> element carrying the live
 * MediaStream — iOS keeps "live stream" audio alive in background.
 * The element is only a near-silent SESSION CARRIER; the audible path is the
 * direct WebAudio output, which has no "paused by system" state. */
async function startStreamTap() {
  if (!streamDest) return
  if (!streamAudio) {
    streamAudio = new Audio()
    streamAudio.setAttribute('playsinline', '')
    streamAudio.setAttribute('webkit-playsinline', '')
    streamAudio.volume = 0.01
  }
  if (streamAudio.srcObject !== streamDest.stream) {
    streamAudio.srcObject = streamDest.stream
    // on* properties (not addEventListener) so repeated start/stop cycles
    // never stack duplicate handlers.
    streamAudio.onpause = resumeInterruptedAudio
    streamAudio.onplay = applyAudioRoute
  }
  try {
    await streamAudio.play()
  } catch (err) {
    console.warn('stream tap play failed, fallback to direct output', err)
    // Fallback: also feed the speakers directly so audio is never lost.
    if (player && audioContext) {
      try {
        player.connect(audioContext.destination)
      } catch {
        /* ignore */
      }
    }
  }
}

function stopStreamTap() {
  if (streamAudio) {
    try {
      streamAudio.pause()
      streamAudio.srcObject = null
    } catch {
      /* ignore */
    }
  }
}

/** PATCH(v4): dual-path routing per MDN-verified iOS behaviour.
 * Foreground: direct WebAudio output (low latency), element stays a
 * near-silent session carrier. Background: audible path MUST be the element
 * (iOS freezes AudioContext hardware output; the system "play" button
 * resumes elements, never WebAudio) — element volume 1, direct cut to avoid
 * double audio. */
function applyAudioRoute() {
  if (!streamAudio) return
  if (document.hidden) {
    streamAudio.volume = 1
    if (player && audioContext) {
      try {
        player.disconnect(audioContext.destination)
      } catch {
        /* ignore */
      }
    }
  } else {
    if (player && audioContext) {
      try {
        player.connect(audioContext.destination)
      } catch {
        /* ignore */
      }
    }
    streamAudio.volume = 0.01
  }
}
document.addEventListener('visibilitychange', applyAudioRoute)

/** PATCH(v5): auto-reclaim after audio interruption. AIRPODS RULE (verified
 * against Apple docs): switching is triggered by a device STARTING playback,
 * and idle AirPods stay where they are. So any automatic resume here IS a
 * steal — it yanks the AirPods off the phone seconds after the user switched.
 * Therefore auto-reclaim defaults to OFF. The no-touch return path is the
 * lock-screen play button (mediaSession handler), which is a user gesture.
 * Turning the toggle ON opts into aggressive reclaim (it will steal). */
function autoReclaimEnabled() {
  try {
    // v5 key: old 'autoReclaim' values are ignored on purpose.
    return localStorage.getItem('autoReclaimMode') === 'on'
  } catch {
    return false
  }
}

/** @param {boolean} [force] true when called from a user gesture
 * (lock-screen play / in-page buttons) — bypasses the reclaim toggle. */
function resumeInterruptedAudio(force) {
  if (!listening || (!force && !autoReclaimEnabled())) return
  // WebAudio自救：interrupted/suspended 状态直接 resume（MDN iOS 模式）
  if (audioContext && audioContext.state !== 'running') {
    audioContext.resume().catch(() => {
      /* ignore */
    })
  }
  let attempt = 0
  const tryOnce = () => {
    if (!listening || !autoReclaimEnabled()) return
    let pending = false
    for (const el of [streamAudio, keepAliveAudio]) {
      if (el && el.paused) {
        pending = true
        el.play()
          .then(applyAudioRoute)
          .catch(() => {
            /* interruption may still be active — retry below */
          })
      }
    }
    // play() can fail right after the route switch while iOS is still
    // processing the handoff — back off and retry (1s,2s,… capped ~1min).
    if (pending && attempt < 12) {
      attempt += 1
      setTimeout(tryOnce, attempt * 1000)
    }
  }
  tryOnce()
}

/** Keep the phone screen on. Must run inside a user gesture (click). */
function enableNoSleep() {
  if (!noSleep) return
  try {
    const result = noSleep.enable()
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.warn('NoSleep enable failed', err))
    }
  } catch (err) {
    console.warn('NoSleep enable failed', err)
  }
}

function disableNoSleep() {
  if (!noSleep) return
  try {
    noSleep.disable()
  } catch {
    /* ignore */
  }
}

function destroyPlayer() {
  if (player) {
    try {
      if (playerMode === 'worklet') {
        player.port.postMessage({ type: 'reset' })
      }
      player.disconnect()
    } catch {
      /* ignore */
    }
    player = null
  }
  playerMode = null
  scriptQueue.clear()
  streamDest = null
}

async function ensurePlayer(sampleRate) {
  if (audioContext && player && Math.abs(audioContext.sampleRate - sampleRate) < 1) {
    if (audioContext.state === 'suspended') await audioContext.resume()
    return
  }

  destroyPlayer()
  if (audioContext) {
    try {
      await audioContext.close()
    } catch {
      /* ignore */
    }
    audioContext = null
  }

  audioContext = new AudioContext({ sampleRate })
  // PATCH(v4): MDN-documented iOS Safari pattern — backgrounding the page
  // sets the context to 'interrupted'; calling resume() (allowed without a
  // gesture here) brings the render graph back so the MediaStream keeps
  // feeding. PATCH(v5): on 'running' we only recompute routing — starting
  // element playback here would steal the AirPods from the phone.
  audioContext.onstatechange = () => {
    const st = audioContext?.state
    if (st === 'interrupted') {
      audioContext.resume().catch(() => {
        /* retried on next statechange */
      })
    } else if (st === 'running') {
      applyAudioRoute()
    }
  }
  const actualRate = audioContext.sampleRate
  if (Math.abs(actualRate - sampleRate) > 1) {
    console.warn(`AudioContext sampleRate=${actualRate}, stream=${sampleRate}`)
  }

  const canWorklet =
    window.isSecureContext && typeof audioContext.audioWorklet?.addModule === 'function'

  if (canWorklet) {
    try {
      await audioContext.audioWorklet.addModule('./audio-player.js')
      const node = new AudioWorkletNode(audioContext, 'audio-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      // PATCH(background): output through a MediaStreamDestination — iOS
      // only keeps "live stream" audio playing while the screen is off.
      streamDest = audioContext.createMediaStreamDestination()
      node.connect(streamDest)
      // PATCH(latency): direct path restores low-latency output; the element
      // tap is demoted to a near-silent session carrier (see applyAudioRoute).
      node.connect(audioContext.destination)
      node.port.onmessage = (ev) => {
        const msg = ev.data
        if (msg?.type === 'stats') {
          if (powerSave) return
          bufferedEl.textContent = String(msg.bufferedFrames)
          levelEl.style.width = `${Math.min(100, Math.round((msg.level || 0) * 140))}%`
        }
      }
      player = node
      playerMode = 'worklet'
      if (powerSave) setStatsEnabled(false)
      if (audioContext.state === 'suspended') await audioContext.resume()
      await startStreamTap()
      return
    } catch (err) {
      console.warn('AudioWorklet failed, fallback to ScriptProcessor', err)
      destroyPlayer()
    }
  }

  const bufferSize = 2048
  const sp = audioContext.createScriptProcessor(bufferSize, 0, 2)
  sp.onaudioprocess = (ev) => {
    const outL = ev.outputBuffer.getChannelData(0)
    const outR = ev.outputBuffer.getChannelData(1)
    const interleaved = scriptQueue.pull(bufferSize)
    if (powerSave) {
      for (let i = 0; i < bufferSize; i++) {
        outL[i] = interleaved[i * 2] || 0
        outR[i] = interleaved[i * 2 + 1] || 0
      }
      return
    }
    let peak = 0
    for (let i = 0; i < bufferSize; i++) {
      const l = interleaved[i * 2] || 0
      const r = interleaved[i * 2 + 1] || 0
      outL[i] = l
      outR[i] = r
      const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r)
      if (a > peak) peak = a
    }
    bufferedEl.textContent = String(scriptQueue.frames())
    levelEl.style.width = `${Math.min(100, Math.round(peak * 140))}%`
  }
  const silent = audioContext.createGain()
  silent.gain.value = 0
  silent.connect(sp)
  // PATCH(background): same live-stream tap as worklet mode.
  streamDest = audioContext.createMediaStreamDestination()
  sp.connect(streamDest)
  // PATCH(latency): direct path for foreground low latency.
  sp.connect(audioContext.destination)
  player = sp
  playerMode = 'script'

  if (audioContext.state === 'suspended') await audioContext.resume()
  await startStreamTap()
}

function feedPcm(arrayBuffer) {
  if (!player) return
  if (playerMode === 'worklet') {
    player.port.postMessage(arrayBuffer, [arrayBuffer])
    return
  }
  if (playerMode === 'script') {
    scriptQueue.push(new Float32Array(arrayBuffer))
  }
}

async function applyAudioConfig(msg) {
  config = {
    sampleRate: Number(msg.sampleRate) || 48000,
    channels: Number(msg.channels) || 2,
    format: msg.format || 'f32',
  }
  sampleRateEl.textContent = `${config.sampleRate} Hz`
  channelsEl.textContent = String(config.channels)
  setStatus('收到配置，初始化播放器…', true)
  try {
    await ensurePlayer(config.sampleRate)
    setStatus(playingLabel(), true)
  } catch (err) {
    console.error(err)
    setStatus(`播放器初始化失败：${err.message || err}`)
  }
}

/** Resume after returning to the page — reconnect WS if it was paused or dropped. */
async function resumePlayback() {
  if (!listening) return
  if (document.hidden) return

  const wasPaused = backgroundPaused
  backgroundPaused = false
  clearReconnect()
  bumpIdle()

  enableNoSleep()
  await startKeepAliveMedia()
  // Re-arm the live-stream tap (iOS may have paused the element in background)
  await startStreamTap()

  if (audioContext && audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
    } catch (err) {
      console.warn('AudioContext.resume failed', err)
    }
  }

  const needWs =
    wasPaused || !ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED

  if (needWs) {
    reconnectAttempt = 0
    setStatus('回到前台，正在重连…', true)
    connectWs()
    return
  }

  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'get-config' }))
    } catch {
      /* ignore */
    }
    if (config && player) setStatus(playingLabel(), true)
  }
}

function connectWs() {
  clearReconnect()

  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }

  ws = new WebSocket(wsUrl())
  ws.binaryType = 'arraybuffer'
  setStatus('连接中…')

  ws.onopen = () => {
    reconnectAttempt = 0
    setStatus(config ? playingLabel() : '已连接，等待音频配置…', true)
    ws.send(JSON.stringify({ type: 'get-config' }))
  }

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.type === 'audio-config') {
        applyAudioConfig(msg)
      } else if (msg.type === 'error') {
        setStatus(`错误：${msg.message}`)
      } else if (msg.type === 'status') {
        if (!config) setStatus(msg.message, String(msg.message).includes('start'))
      }
      return
    }

    if (event.data instanceof ArrayBuffer) {
      feedPcm(event.data)
    }
  }

  ws.onclose = () => {
    ws = null
    if (backgroundPaused || document.hidden) {
      // Closed because page went to background — wait for foreground
      return
    }
    if (listening) {
      scheduleReconnect()
    } else {
      setStatus('连接已断开')
      btnStart.disabled = false
      btnStop.disabled = true
    }
  }

  ws.onerror = () => {
    if (!listening) setStatus('WebSocket 错误')
  }
}

async function start() {
  listening = true
  backgroundPaused = false
  btnStart.disabled = true
  btnStop.disabled = false
  config = null
  reconnectAttempt = 0
  clearReconnect()
  exitPowerSave()
  schedulePowerSave()
  enableNoSleep()

  const unlock = new AudioContext()
  if (unlock.state === 'suspended') await unlock.resume()
  await unlock.close()

  enablePlaybackSession()
  await startKeepAliveMedia()
  connectWs()
}

async function stop() {
  listening = false
  backgroundPaused = false
  clearReconnect()
  clearPowerSaveTimer()
  exitPowerSave()
  reconnectAttempt = 0
  btnStart.disabled = false
  btnStop.disabled = true

  disableNoSleep()
  stopKeepAliveMedia()
  stopStreamTap()

  if (ws) {
    ws.onclose = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }
  destroyPlayer()
  if (audioContext) {
    try {
      await audioContext.close()
    } catch {
      /* ignore */
    }
    audioContext = null
  }
  config = null
  setStatus('已停止')
  bufferedEl.textContent = '0'
  levelEl.style.width = '0%'
}

btnStart.addEventListener('click', () => {
  enableNoSleep()
  start().catch((err) => {
    console.error(err)
    setStatus(String(err.message || err))
    listening = false
    clearPowerSaveTimer()
    exitPowerSave()
    disableNoSleep()
    btnStart.disabled = false
    btnStop.disabled = true
  })
})
btnStop.addEventListener('click', () => {
  stop().catch(console.error)
})

window.addEventListener(
  'pointerdown',
  () => {
    if (listening) bumpIdle()
  },
  { passive: true },
)
window.addEventListener(
  'keydown',
  () => {
    if (listening) bumpIdle()
  },
  { passive: true },
)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // PATCH: keep streaming in background. The silent keepalive audio holds
    // an active media session, so the page is not frozen while screen is off.
    // Only guard against a suspended AudioContext.
    if (listening && audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {})
    }
  } else {
    resumePlayback().catch(console.error)
  }
})

window.addEventListener('pagehide', () => {
  pauseForBackground()
})

window.addEventListener('pageshow', (ev) => {
  if (ev.persisted || document.visibilityState === 'visible') {
    resumePlayback().catch(console.error)
  }
})

window.addEventListener('focus', () => {
  if (!document.hidden) {
    resumePlayback().catch(console.error)
  }
})

// Some mobiles fire this when unlocking screen while page stays "visible"
document.addEventListener('resume', () => {
  resumePlayback().catch(console.error)
})
