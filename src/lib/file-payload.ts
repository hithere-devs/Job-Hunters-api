import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'

/** Transfer bytes through Playwright, not a path owned by a different Linux tenant. */
export async function browserFilePayload(filePath: string) {
  const info = await stat(filePath)
  if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('Prepared upload must be a file no larger than 20 MB.')
  const mimeType = ({'.pdf':'application/pdf','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain'} as Record<string,string>)[path.extname(filePath).toLowerCase()]
  if (!mimeType) throw new Error('Unsupported prepared upload file type.')
  return {name:path.basename(filePath),mimeType,buffer:await readFile(filePath)}
}
