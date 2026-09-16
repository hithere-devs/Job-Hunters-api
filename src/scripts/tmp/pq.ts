import { db } from '../../db/client.js'
import { sql } from 'drizzle-orm'
async function main(){
 const r:any=await db.execute(sql.raw(`select q.status, q.host, left(q.label,78) as label, q.type, q.required, q.sensitive,
   left(coalesce(q.answer,''),22) as answer, left(coalesce(q.blocked_reason,''),50) as blocked
   from pending_application_questions q where q.created_at > now() - interval '12 minutes' order by q.created_at desc limit 14`))
 console.log('## pending questions this attempt'); for(const row of (r.rows??r)) console.log(JSON.stringify(row))
 process.exit(0)
}
void main()
