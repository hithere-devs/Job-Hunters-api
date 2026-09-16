/** Bound infrastructure probes without changing BullMQ's required retry policy. */
export async function withDeadline<T>(operation:Promise<T>,ms:number):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined
 try {return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Infrastructure operation timed out')),ms);timer.unref()})])} finally {if(timer)clearTimeout(timer)}
}
