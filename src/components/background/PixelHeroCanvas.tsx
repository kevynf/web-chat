import { useEffect, useRef } from 'react'
import styles from './PixelHeroCanvas.module.css'

const CELL_SIZE = 5
const CELL_GAP = 2
const THRESHOLD = 0.72
const THRESHOLD_JITTER = 0.08
const GREEN_RATIO = 0.49
const DENSITY = 1.5
const FREQUENCY = 2.5
const FLOW_GAIN = 35
const MOUSE_RADIUS = 100
const MOUSE_STRENGTH = 1.3
const TIME_SCALE = 0.85
const TIME_STORAGE_KEY = 'pixel-hero-time'

const hexToRgb = (hex: string): [number, number, number] => {
  let value = hex.trim().replace('#', '')
  if (value.length === 3) {
    value = value
      .split('')
      .map((char) => char + char)
      .join('')
  }
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  ]
}

const readStoredTime = () => {
  try {
    const value = Number(sessionStorage.getItem(TIME_STORAGE_KEY))
    return Number.isFinite(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

const persistTime = (value: number) => {
  try {
    sessionStorage.setItem(TIME_STORAGE_KEY, String(Math.round(value * 100) / 100))
  } catch {
    // Storage can be unavailable in private contexts.
  }
}

const VERTEX_SRC = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FIELD_FRAG_SRC = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uAccent;
uniform vec3 uGray;
uniform vec3 uBg;
uniform float uDpr;
uniform float uCellDev;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}
vec2 hash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float noise(vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  vec2 o = (a.x > a.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, hash(i + 0.0)), dot(b, hash(i + o)), dot(c, hash(i + 1.0)));
  return dot(n, vec3(70.0));
}
float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int i = 0; i < 3; i++) {
    value += amplitude * noise(p * frequency);
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return value * 0.5 + 0.5;
}
vec2 fluidQ(vec2 uv) {
  return vec2(
    fbm(uv * ${DENSITY} + vec2(0.0, 0.03 * uTime)),
    fbm(uv * ${DENSITY} + vec2(1.2, -0.045 * uTime))
  );
}
float fluidNoise(vec2 uv) {
  return fbm(uv * ${DENSITY} + fluidQ(uv) * ${FREQUENCY});
}

void main() {
  vec2 cellId = floor(gl_FragCoord.xy);
  vec2 cellCenter = (cellId + 0.5) * uCellDev / uDpr;
  vec2 cellCenterUV = cellCenter / uRes;

  float rand = random(cellId);

  vec2 q = fluidQ(cellCenterUV);
  vec2 flowPx = vec2(q.x * 0.15, q.y * 2.1) * ${FLOW_GAIN.toFixed(1)};
  vec2 sampledUv = cellCenterUV - flowPx / uRes;

  float brightness = fluidNoise(sampledUv);

  float dist = distance(cellCenterUV * uRes, uMouse * uRes);
  float mouseFactor = clamp((1.0 - smoothstep(0.0, ${MOUSE_RADIUS.toFixed(1)}, dist)) * ${MOUSE_STRENGTH}, 0.0, 1.0);

  if (brightness > ${THRESHOLD} - ${THRESHOLD_JITTER} * rand) {
    bool accentDot = rand < ${GREEN_RATIO};
    vec3 color = accentDot ? uAccent : uGray;
    vec3 other = accentDot ? uGray : uAccent;
    gl_FragColor = vec4(mix(color, other, mouseFactor), 1.0);
  } else {
    gl_FragColor = vec4(uBg, 0.0);
  }
}
`

const RASTER_FRAG_SRC = `
precision highp float;
uniform sampler2D uField;
uniform vec2 uFieldSize;
uniform float uCellDev;
uniform float uTileHalf;
uniform vec3 uBg;

void main() {
  vec2 cellId = floor(gl_FragCoord.xy / uCellDev);
  vec2 posInCell = gl_FragCoord.xy - cellId * uCellDev;
  vec2 offset = abs(posInCell - uCellDev * 0.5);
  float dotMask = step(max(offset.x, offset.y), uTileHalf);

  vec4 field = texture2D(uField, (cellId + 0.5) / uFieldSize);

  if (field.a > 0.5 && dotMask > 0.5) {
    gl_FragColor = vec4(field.rgb, 1.0);
  } else {
    gl_FragColor = vec4(uBg, 1.0);
  }
}
`

/** 欢迎页的流体像素背景：WebGL 流体噪声 + 像素网格，跟随主题色并支持鼠标扰动。 */
export const PixelHeroCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const gl = canvas.getContext('webgl', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    })
    if (!gl) {
      // eslint-disable-next-line no-console
      console.warn('[pixel-hero] WebGL 不可用')
      return
    }

    let rafId = 0
    let resizeTimer = 0
    let dpr = 1
    let cellDev = 7
    let cols = 1
    let rows = 1
    let mouseUv: [number, number] = [0.5, 0.5]
    let disposed = false
    const cleanups: Array<() => void> = []

    const dispose = () => {
      if (disposed) {
        return
      }
      disposed = true
      cancelAnimationFrame(rafId)
      clearTimeout(resizeTimer)
      for (const cleanup of cleanups.splice(0)) {
        cleanup()
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }

    try {
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type)
        if (!shader) {
          throw new Error('无法创建 shader')
        }
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(`pixel-hero shader: ${gl.getShaderInfoLog(shader)}`)
        }
        return shader
      }

      const createProgram = (fragmentSource: string) => {
        const program = gl.createProgram()
        if (!program) {
          return null
        }
        gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SRC))
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource))
        gl.bindAttribLocation(program, 0, 'aPos')
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(`pixel-hero program: ${gl.getProgramInfoLog(program)}`)
        }
        return program
      }

      const fieldProgram = createProgram(FIELD_FRAG_SRC)
      const rasterProgram = createProgram(RASTER_FRAG_SRC)
      if (!fieldProgram || !rasterProgram) {
        dispose()
        return
      }

      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

      const fieldTex = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, fieldTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      const fbo = gl.createFramebuffer()

      const fu = {
        uRes: gl.getUniformLocation(fieldProgram, 'uRes'),
        uTime: gl.getUniformLocation(fieldProgram, 'uTime'),
        uMouse: gl.getUniformLocation(fieldProgram, 'uMouse'),
        uAccent: gl.getUniformLocation(fieldProgram, 'uAccent'),
        uGray: gl.getUniformLocation(fieldProgram, 'uGray'),
        uBg: gl.getUniformLocation(fieldProgram, 'uBg'),
        uDpr: gl.getUniformLocation(fieldProgram, 'uDpr'),
        uCellDev: gl.getUniformLocation(fieldProgram, 'uCellDev'),
      }
      const ru = {
        uField: gl.getUniformLocation(rasterProgram, 'uField'),
        uFieldSize: gl.getUniformLocation(rasterProgram, 'uFieldSize'),
        uCellDev: gl.getUniformLocation(rasterProgram, 'uCellDev'),
        uBg: gl.getUniformLocation(rasterProgram, 'uBg'),
        uTileHalf: gl.getUniformLocation(rasterProgram, 'uTileHalf'),
      }

      const resize = () => {
        dpr = window.devicePixelRatio || 1
        const rect = canvas.getBoundingClientRect()
        const width = Math.max(1, Math.floor(rect.width))
        const height = Math.max(1, Math.floor(rect.height))
        canvas.width = Math.max(1, Math.floor(width * dpr))
        canvas.height = Math.max(1, Math.floor(height * dpr))

        cellDev = Math.max(2, Math.round((CELL_SIZE + CELL_GAP) * dpr))
        cols = Math.max(1, Math.ceil(canvas.width / cellDev))
        rows = Math.max(1, Math.ceil(canvas.height / cellDev))

        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, fieldTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fieldTex, 0)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          // eslint-disable-next-line no-console
          console.error('pixel-hero framebuffer 不完整')
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)

        gl.useProgram(fieldProgram)
        gl.uniform2f(fu.uRes, width, height)
        gl.uniform1f(fu.uDpr, dpr)
        gl.uniform1f(fu.uCellDev, cellDev)

        gl.useProgram(rasterProgram)
        gl.uniform1i(ru.uField, 0)
        gl.uniform2f(ru.uFieldSize, cols, rows)
        gl.uniform1f(ru.uCellDev, cellDev)
        const devPerLogical = cellDev / (CELL_SIZE + CELL_GAP)
        gl.uniform1f(ru.uTileHalf, (CELL_SIZE / 2) * devPerLogical)
      }
      resize()

      const applyThemeColors = () => {
        const rootStyle = getComputedStyle(document.body)
        const readVar = (name: string, fallback: string) =>
          rootStyle.getPropertyValue(name).trim() || fallback
        const accent = hexToRgb(readVar('--dsw-alias-brand-primary', '#3b6ea5'))
        const gray = hexToRgb(readVar('--dsw-alias-label-tertiary', '#6a6f74'))
        const bg = hexToRgb(readVar('--dsw-alias-bg-base', '#f7f7f6'))
        gl.useProgram(fieldProgram)
        gl.uniform3fv(fu.uAccent, accent)
        gl.uniform3fv(fu.uGray, gray)
        gl.uniform3fv(fu.uBg, bg)
        gl.useProgram(rasterProgram)
        gl.uniform3fv(ru.uBg, bg)
      }
      applyThemeColors()
      void document.fonts?.ready.then(() => {
        if (!disposed) {
          applyThemeColors()
        }
      })

      const onPointerMove = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
          return
        }
        mouseUv = [
          (event.clientX - rect.left) / rect.width,
          1 - (event.clientY - rect.top) / rect.height,
        ]
      }
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      cleanups.push(() => window.removeEventListener('pointermove', onPointerMove))

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      let timeAcc = reducedMotion ? 40 : readStoredTime()
      let lastFrame = performance.now()

      const renderFrame = () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.viewport(0, 0, cols, rows)
        gl.useProgram(fieldProgram)
        gl.uniform1f(fu.uTime, timeAcc)
        gl.uniform2f(fu.uMouse, mouseUv[0], mouseUv[1])
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.useProgram(rasterProgram)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }

      const runningState = { pageVisible: !document.hidden, contextLost: false }

      const tick = (now: number) => {
        const delta = Math.min(now - lastFrame, 50)
        lastFrame = now
        timeAcc += (delta / 1000) * TIME_SCALE
        renderFrame()
        rafId = requestAnimationFrame(tick)
      }

      const updateLoop = () => {
        const shouldRun =
          runningState.pageVisible && !runningState.contextLost && !reducedMotion
        if (shouldRun && !rafId) {
          lastFrame = performance.now()
          rafId = requestAnimationFrame(tick)
        } else if (!shouldRun && rafId) {
          cancelAnimationFrame(rafId)
          rafId = 0
        }
      }

      if (reducedMotion) {
        renderFrame()
      }

      const syncTheme = () => {
        applyThemeColors()
        if (!rafId) {
          renderFrame()
        }
      }
      const themeObserver = new MutationObserver(syncTheme)
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'data-ds-dark-theme'],
      })
      cleanups.push(() => themeObserver.disconnect())

      const onVisibilityChange = () => {
        if (document.hidden) {
          persistTime(timeAcc)
        }
        runningState.pageVisible = !document.hidden
        updateLoop()
      }
      document.addEventListener('visibilitychange', onVisibilityChange)
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange))

      const onPageHide = () => persistTime(timeAcc)
      window.addEventListener('pagehide', onPageHide)
      cleanups.push(() => window.removeEventListener('pagehide', onPageHide))
      cleanups.push(() => persistTime(timeAcc))

      const onContextLost = (event: Event) => {
        event.preventDefault()
        runningState.contextLost = true
        updateLoop()
      }
      canvas.addEventListener('webglcontextlost', onContextLost)
      cleanups.push(() => canvas.removeEventListener('webglcontextlost', onContextLost))

      const resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(() => {
          if (disposed) {
            return
          }
          resize()
          if (!rafId) {
            renderFrame()
          }
        }, 120)
      })
      resizeObserver.observe(canvas)
      cleanups.push(() => resizeObserver.disconnect())

      syncTheme()
      updateLoop()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[pixel-hero] 初始化失败:', error)
      dispose()
    }

    return dispose
  }, [])

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
}
