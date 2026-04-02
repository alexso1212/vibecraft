#!/usr/bin/env npx tsx
/**
 * Meshy Animation Pipeline
 *
 * 一句话描述 → 3D模型 + 骨骼绑定 + 动画 → GLB 文件
 *
 * Usage:
 *   npx tsx scripts/animate-pipeline.ts "Trump doing YMCA dance"
 *   npx tsx scripts/animate-pipeline.ts --list-animations
 *   npx tsx scripts/animate-pipeline.ts --animate-only <rig_task_id> <action_id>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'

// ── Config ──────────────────────────────────────────────────────────

const SECRETS_PATH = resolve(process.env.HOME || '~', '.secrets/api-keys.json')
const OUTPUT_DIR = resolve(import.meta.dirname, '..', 'public', 'models')
const MESHY_BASE = 'https://api.meshy.ai'
const POLL_INTERVAL = 5000 // 5s between status checks
const MAX_POLL_TIME = 600000 // 10 min max per step

// Dance animation presets (action_id → name)
const DANCE_PRESETS: Record<number, string> = {
  22: 'FunnyDancing_01',
  23: 'FunnyDancing_02',
  24: 'FunnyDancing_03',
  63: 'Arm_Circle_Shuffle',
  64: 'All_Night_Dance',
  65: 'Bass_Beats',
  66: 'Boom_Dance',
  67: 'Bubble_Dance',
  68: 'Cherish_Pop_Dance',
  69: 'Crystal_Beads',
  70: 'Cardio_Dance',
  71: 'Denim_Pop_Dance',
  72: 'Dont_You_Dare',
  73: 'Fast_Lightning',
  74: 'Gangnam_Groove',
  75: 'Indoor_Swing',
  76: 'Love_You_Pop_Dance',
  77: 'Magic_Genie',
  78: 'Not_Your_Mom',
  79: 'OMG_Groove',
  80: 'Pop_Dance_LSA2',
  81: 'Pod_Baby_Groove',
  82: 'Shake_It_Off_Dance',
  83: 'Superlove_Pop_Dance',
  84: 'You_Groove',
}

// Common presets for keyword matching
const ANIMATION_KEYWORDS: Record<string, number[]> = {
  dance: [22, 23, 24, 64, 65, 66, 67, 68, 74, 79, 82, 83, 84],
  ymca: [22, 63], // arm-heavy dances
  gangnam: [74],
  shake: [82],
  party: [64, 66, 79, 84],
  pop: [68, 71, 76, 80, 83],
  funny: [22, 23, 24],
  cardio: [70],
  swing: [75],
  walk: [1, 30],
  run: [5, 6, 13, 14, 15, 16],
  idle: [0, 11, 12],
  sit: [32, 33],
  cheer: [49],
}

// ── Helpers ──────────────────────────────────────────────────────────

function loadApiKey(): string {
  const secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'))
  const key = secrets.meshy?.key
  if (!key) throw new Error('Meshy API key not found in ~/.secrets/api-keys.json')
  return key
}

async function meshyRequest(
  apiKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = `${MESHY_BASE}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meshy API ${method} ${path} failed (${res.status}): ${text}`)
  }

  return res.json()
}

interface PollResult {
  status: string
  progress: number
  [key: string]: unknown
}

async function pollUntilDone(
  apiKey: string,
  path: string,
  stepName: string
): Promise<PollResult> {
  const start = Date.now()
  let lastProgress = -1

  while (Date.now() - start < MAX_POLL_TIME) {
    const result = (await meshyRequest(apiKey, 'GET', path)) as PollResult

    if (result.progress !== lastProgress) {
      lastProgress = result.progress
      log(`  ${stepName}: ${result.status} (${result.progress}%)`)
    }

    if (result.status === 'SUCCEEDED') return result
    if (result.status === 'FAILED') {
      throw new Error(`${stepName} failed: ${(result as Record<string, unknown>).error || 'unknown error'}`)
    }
    if (result.status === 'CANCELED') {
      throw new Error(`${stepName} was canceled`)
    }

    await sleep(POLL_INTERVAL)
  }

  throw new Error(`${stepName} timed out after ${MAX_POLL_TIME / 1000}s`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ${msg}`)
}

function matchAnimationId(description: string): number {
  const lower = description.toLowerCase()

  // Check keyword matches
  for (const [keyword, ids] of Object.entries(ANIMATION_KEYWORDS)) {
    if (lower.includes(keyword)) {
      // Return first match
      return ids[0]
    }
  }

  // Default to FunnyDancing_01 for any unmatched dance request
  if (lower.includes('舞') || lower.includes('跳')) {
    return 22
  }

  // Fallback to idle
  return 0
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  writeFileSync(destPath, buffer)
}

// ── Pipeline Steps ──────────────────────────────────────────────────

async function step1_textTo3D(apiKey: string, prompt: string): Promise<string> {
  log('Step 1/4: 生成3D模型 (preview)...')
  const result = (await meshyRequest(apiKey, 'POST', '/openapi/v2/text-to-3d', {
    mode: 'preview',
    prompt,
    ai_model: 'meshy-6',
    topology: 'quad',
    target_polycount: 30000,
  })) as { result: string }

  const taskId = result.result
  log(`  Preview task: ${taskId}`)

  const preview = await pollUntilDone(apiKey, `/openapi/v2/text-to-3d/${taskId}`, 'Preview')
  log('  ✓ Preview 完成')

  // Step 1b: Refine (add textures)
  log('Step 1b/4: 细化纹理 (refine)...')
  const refineResult = (await meshyRequest(apiKey, 'POST', '/openapi/v2/text-to-3d', {
    mode: 'refine',
    preview_task_id: taskId,
    enable_pbr: true,
  })) as { result: string }

  const refineId = refineResult.result
  log(`  Refine task: ${refineId}`)

  const refined = await pollUntilDone(apiKey, `/openapi/v2/text-to-3d/${refineId}`, 'Refine')
  log('  ✓ Refine 完成')

  return refineId
}

async function step1b_remesh(apiKey: string, textTo3dTaskId: string): Promise<string> {
  log('Step 1c/5: 减面 (remesh to <300k faces)...')
  const result = (await meshyRequest(apiKey, 'POST', '/openapi/v1/remesh', {
    input_task_id: textTo3dTaskId,
    target_polycount: 50000,
    topology: 'quad',
  })) as { result: string }

  const taskId = result.result
  log(`  Remesh task: ${taskId}`)

  const remeshed = await pollUntilDone(apiKey, `/openapi/v1/remesh/${taskId}`, 'Remesh')
  log('  ✓ Remesh 完成')

  return taskId
}

async function step2_rig(apiKey: string, inputTaskId: string): Promise<string> {
  log('Step 2/5: 骨骼绑定 (rigging)...')
  const result = (await meshyRequest(apiKey, 'POST', '/openapi/v1/rigging', {
    input_task_id: inputTaskId,
    height_meters: 1.7,
  })) as { result: string }

  const taskId = result.result
  log(`  Rig task: ${taskId}`)

  const rigged = await pollUntilDone(apiKey, `/openapi/v1/rigging/${taskId}`, 'Rigging')
  log('  ✓ Rigging 完成')

  return taskId
}

async function step3_animate(apiKey: string, rigTaskId: string, actionId: number): Promise<string> {
  const animName = DANCE_PRESETS[actionId] || `action_${actionId}`
  log(`Step 3/4: 应用动画 (${animName}, id=${actionId})...`)

  const result = (await meshyRequest(apiKey, 'POST', '/openapi/v1/animations', {
    rig_task_id: rigTaskId,
    action_id: actionId,
  })) as { result: string }

  const taskId = result.result
  log(`  Animation task: ${taskId}`)

  const animated = await pollUntilDone(apiKey, `/openapi/v1/animations/${taskId}`, 'Animation')
  log('  ✓ Animation 完成')

  return taskId
}

async function step4_download(apiKey: string, animTaskId: string, outputName: string): Promise<string> {
  log('Step 4/4: 下载 GLB...')

  const result = (await meshyRequest(apiKey, 'GET', `/openapi/v1/animations/${animTaskId}`)) as {
    result?: { animation_glb_url?: string }
    animation_glb_url?: string
  }

  const glbUrl = result.result?.animation_glb_url || result.animation_glb_url
  if (!glbUrl) throw new Error('No GLB URL in animation result')

  mkdirSync(OUTPUT_DIR, { recursive: true })
  const filename = `${outputName}.glb`
  const destPath = join(OUTPUT_DIR, filename)

  await downloadFile(glbUrl, destPath)
  log(`  ✓ 已保存: public/models/${filename}`)

  return destPath
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // --list-animations
  if (args[0] === '--list-animations') {
    console.log('\n🎭 可用舞蹈动画预设:\n')
    for (const [id, name] of Object.entries(DANCE_PRESETS)) {
      console.log(`  ${id.padStart(3)}: ${name}`)
    }
    console.log('\n🔤 关键词匹配:\n')
    for (const [keyword, ids] of Object.entries(ANIMATION_KEYWORDS)) {
      console.log(`  "${keyword}" → action_id ${ids.join(', ')}`)
    }
    return
  }

  // --animate-only <rig_task_id> <action_id>
  if (args[0] === '--animate-only') {
    const rigTaskId = args[1]
    const actionId = parseInt(args[2], 10)
    if (!rigTaskId || isNaN(actionId)) {
      console.error('Usage: --animate-only <rig_task_id> <action_id>')
      process.exit(1)
    }
    const apiKey = loadApiKey()
    const animId = await step3_animate(apiKey, rigTaskId, actionId)
    await step4_download(apiKey, animId, `animated_${actionId}`)
    return
  }

  // --rig-and-animate <text-to-3d-task-id> <action_id>
  if (args[0] === '--rig-and-animate') {
    const t2dTaskId = args[1]
    const actionId = parseInt(args[2] || '22', 10)
    if (!t2dTaskId) {
      console.error('Usage: --rig-and-animate <text-to-3d-task-id> [action_id]')
      process.exit(1)
    }
    const apiKey = loadApiKey()
    const remeshId = await step1b_remesh(apiKey, t2dTaskId)
    const rigId = await step2_rig(apiKey, remeshId)
    const animId = await step3_animate(apiKey, rigId, actionId)
    await step4_download(apiKey, animId, `animated_${actionId}`)
    return
  }

  // Full pipeline: text description
  const description = args.join(' ')
  if (!description) {
    console.log(`
🎬 Meshy Animation Pipeline

Usage:
  npx tsx scripts/animate-pipeline.ts "Trump doing YMCA dance"
  npx tsx scripts/animate-pipeline.ts --list-animations
  npx tsx scripts/animate-pipeline.ts --animate-only <rig_task_id> <action_id>
  npx tsx scripts/animate-pipeline.ts --rig-and-animate <text-to-3d-task-id> [action_id]

描述中包含关键词会自动匹配动画:
  "dance/舞/跳" → FunnyDancing
  "gangnam"     → Gangnam_Groove
  "shake"       → Shake_It_Off
  "party"       → All_Night_Dance
`)
    process.exit(0)
  }

  const apiKey = loadApiKey()
  const actionId = matchAnimationId(description)
  const animName = DANCE_PRESETS[actionId] || `action_${actionId}`
  const sanitized = description.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30).toLowerCase()
  const outputName = `${sanitized}_${actionId}`

  log(`🎬 开始动画管线`)
  log(`  描述: ${description}`)
  log(`  动画: ${animName} (id=${actionId})`)
  log(`  输出: public/models/${outputName}.glb`)
  console.log('')

  const startTime = Date.now()

  // Step 1: Text → 3D Model
  const refineTaskId = await step1_textTo3D(apiKey, description)

  // Step 1c: Remesh (reduce face count for rigging)
  const remeshTaskId = await step1b_remesh(apiKey, refineTaskId)

  // Step 2: Rig
  const rigTaskId = await step2_rig(apiKey, remeshTaskId)

  // Step 3: Animate
  const animTaskId = await step3_animate(apiKey, rigTaskId, actionId)

  // Step 4: Download
  const destPath = await step4_download(apiKey, animTaskId, outputName)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
  console.log('')
  log(`✅ 完成! 耗时 ${elapsed}s`)
  log(`   文件: ${destPath}`)
  log(`   在 Vibecraft 中使用: 修改 src/main.ts 中的模型路径`)
  log('')
  log(`📋 任务ID (可复用):`)
  log(`   Text-to-3D (refine): ${refineTaskId}`)
  log(`   Remesh: ${remeshTaskId}`)
  log(`   Rigging: ${rigTaskId}`)
  log(`   Animation: ${animTaskId}`)
}

main().catch((err) => {
  console.error('\n❌ Pipeline failed:', err.message)
  process.exit(1)
})
