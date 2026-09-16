import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getRedis } from '../lib/redis.js'
import { conflict } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

const ownership = new AsyncLocalStorage<{key:string;token:string;lost:boolean}>()
export async function assertApprovalLease() {
 const owner=ownership.getStore()
 if (!owner) return
 if (owner.lost || await getRedis().get(owner.key)!==owner.token) throw conflict('Application selection lock expired. Refresh before retrying; saved queue results remain available in Applications.')
}
export async function withApprovalLock<T>(userId:string,operation:()=>Promise<T>):Promise<T> {
 const redis=getRedis(), key=`huntly:approval:${userId}`,token=crypto.randomUUID()
 if(await redis.set(key,token,'PX',120_000,'NX')!=='OK')throw conflict('Another batch is being queued. Wait for it to finish and retry.')
 const owner={key,token,lost:false}
 const timer=setInterval(()=>{void redis.eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("pexpire",KEYS[1],120000) else return 0 end',1,key,token).then(result=>{if(result!==1)owner.lost=true}).catch(()=>{owner.lost=true})},20_000)
 timer.unref()
 try{return await ownership.run(owner,operation)}finally{
  clearInterval(timer)
  await redis.eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',1,key,token).catch(error=>logger.warn({err:error},'could not release approval lock; token expires automatically'))
 }
}
