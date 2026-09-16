import { db } from '../../db/client.js'
import { sql } from 'drizzle-orm'
async function main(){
 const q=async(l:string,t:string)=>{try{const r:any=await db.execute(sql.raw(t));console.log('\n##',l);for(const row of (r.rows??r))console.log(JSON.stringify(row))}catch(e){console.log('\n##',l,'ERR',(e as Error).message.slice(0,120))}}
 await q('mercor infra job',"select j.id, j.title, j.company, j.locations, j.remote_mode, left(j.description_text,180) as descr from jobs j where j.title ilike '%Infrastructure Engineer%' and j.company ilike '%Mercor%' limit 2")
 await q('user kit',"select k.country, k.city, k.work_authorization, k.willing_to_relocate from kits k join users u on u.id=k.user_id where u.email='mywritingfrenzy@gmail.com'")
 await q('resolve context shape',"select column_name from information_schema.columns where table_name='kits' and column_name in ('country','work_authorization','city')")
 process.exit(0)
}
void main()
