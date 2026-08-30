import { randomUUID } from 'node:crypto'
import { createServer, connect, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { QueuedWork, WorkClaimResult } from './work-queue.js'

const upstreamRedisUrl = new URL(process.env.REDIS_URL ?? '')
if (!upstreamRedisUrl.hostname || !upstreamRedisUrl.port) {
  throw new Error(
    'REDIS_URL is required for the non-skipping work claim replay Redis integration gate'
  )
}

interface RedisFaultProxy {
  server: Server
  port: number
  dropNextEvalReply(): void
  wasReplyDropped(): boolean
}

async function startRedisFaultProxy(): Promise<RedisFaultProxy> {
  let dropNextEvalReply = false
  let replyDropped = false
  const server = createServer((client) => {
    const upstream = connect({
      host: upstreamRedisUrl.hostname,
      port: Number(upstreamRedisUrl.port),
    })
    let request = Buffer.alloc(0)
    let dropThisReply = false

    client.on('data', (chunk) => {
      if (dropNextEvalReply) {
        request = Buffer.concat([request, chunk])
        if (request.toString('utf8').toUpperCase().includes('$4\r\nEVAL\r\n')) {
          dropThisReply = true
          dropNextEvalReply = false
        }
      }
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      if (dropThisReply) {
        // The EVAL already committed at Redis. Drop only its reply so ioredis
        // reconnects and replays the exact caller-supplied attempt token.
        dropThisReply = false
        replyDropped = true
        client.destroy()
        upstream.destroy()
        return
      }
      client.write(chunk)
    })
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Redis fault proxy did not bind a TCP port')
  }
  return {
    server,
    port: address.port,
    dropNextEvalReply: () => { dropNextEvalReply = true },
    wasReplyDropped: () => replyDropped,
  }
}

let proxy: RedisFaultProxy
let queueWork: (work: QueuedWork) => Promise<boolean>
let claimWorkWithReceipt: (
  sessionId: string,
  workerId: string,
  attemptToken: string,
) => Promise<WorkClaimResult>
let getWorkStateKey: (sessionId: string) => string
let workQueueKey: string
let workItemsKey: string
let getRedisClient: () => {
  del(...keys: string[]): Promise<number>
  zrem(key: string, member: string): Promise<number>
  hdel(key: string, field: string): Promise<number>
}
let disconnectRedis: () => Promise<void>

beforeAll(async () => {
  proxy = await startRedisFaultProxy()
  process.env.REDIS_URL = `redis://127.0.0.1:${proxy.port}`

  const workQueue = await import('./work-queue.js')
  const redis = await import('./redis.js')
  queueWork = workQueue.queueWork
  claimWorkWithReceipt = workQueue.claimWorkWithReceipt as typeof claimWorkWithReceipt
  getWorkStateKey = workQueue.getWorkStateKey
  workQueueKey = workQueue.WORK_QUEUE_KEY
  workItemsKey = workQueue.WORK_ITEMS_KEY
  getRedisClient = redis.getRedisClient
  disconnectRedis = redis.disconnectRedis
})

afterAll(async () => {
  await disconnectRedis()
  await new Promise<void>((resolve) => proxy.server.close(() => resolve()))
})

describe('work claim replay against a dropped Redis EVAL reply', () => {
  it('replays the caller token to the same durable payload receipt', async () => {
    const sessionId = `work-replay:${randomUUID()}`
    const attemptToken = `attempt:${randomUUID()}`
    const work: QueuedWork = {
      sessionId,
      issueId: `issue:${sessionId}`,
      issueIdentifier: 'OSS-REPLAY',
      priority: 1,
      queuedAt: Date.now(),
    }

    await expect(queueWork(work)).resolves.toBe(true)
    proxy.dropNextEvalReply()

    await expect(
      claimWorkWithReceipt(sessionId, 'worker-replay', attemptToken)
    ).resolves.toMatchObject({
      status: 'claimed',
      sessionId,
      workerId: 'worker-replay',
      attemptToken,
      work,
    })
    expect(proxy.wasReplyDropped()).toBe(true)

    const redis = getRedisClient()
    await redis.zrem(workQueueKey, sessionId)
    await redis.hdel(workItemsKey, sessionId)
    await redis.del(getWorkStateKey(sessionId))
  })
})
