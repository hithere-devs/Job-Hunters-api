import { db } from '../../db/client.js'
import { sql } from 'drizzle-orm'
async function main(){
 const r:any=await db.execute(sql.raw(`select to_char(e.at,'HH24:MI:SS') as t, e.state, e.reason, left(e.detail::text,140) as detail
  from attempt_events e where e.at > now() - interval '8 minutes' order by e.at desc limit 18`))
 console.log('## recent events'); for(const row of (r.rows??r)) console.log(JSON.stringify(row))
 const a:any=await db.execute(sql.raw(`select a.company, a.role, a.status from applications a join users u on u.id=a.user_id where u.email='mywritingfrenzy@gmail.com' order by a.updated_at desc limit 7`))
 console.log('\n## applications'); for(const row of (a.rows??a)) console.log(JSON.stringify(row))
 process.exit(0)
}
void main()
