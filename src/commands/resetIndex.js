import path from 'path'

import { GitIndexManager } from '../managers/GitIndexManager.js'
import { GitObjectManager } from '../managers/GitObjectManager.js'
import { FileSystem } from '../models/FileSystem.js'

import { readObject } from './readObject'
import { log } from './log'

/**
 * Reset a file from the git index (aka staging area)
 *
 * @link https://isomorphic-git.github.io/docs/resetIndex.html
 */
export async function resetIndex ({
  dir,
  gitdir = path.join(dir, '.git'),
  fs: _fs,
  filepath,
  ref = 'HEAD'
}) {
  try {
    const fs = new FileSystem(_fs)
    const tree = await log({ gitdir, fs, ref, depth: 1 })
    let oid = tree[0] && tree[0].tree
    let workdirOid
    if (oid) {
      try {
        const obj = await readObject({ gitdir, fs, oid, filepath, format: 'deflated' })
        oid = obj && obj.oid
      } catch (e) {
        oid = null
      }
      const object = await fs.read(path.join(dir, filepath))
      workdirOid = await GitObjectManager.hash({
        gitdir,
        type: 'blob',
        object
      })
    }
    await GitIndexManager.acquire(
      { fs, filepath: `${gitdir}/index` },
      async function (index) {
        index.delete({ filepath })
        if (oid) {
          let stats = { ctime: new Date(0), mtime: new Date(0), dev: 0, ino: 0, mode: 0, uid: 0, gid: 0, size: 0 }
          if (oid === workdirOid) {
            try {
              stats = await fs._lstat(path.join(dir, filepath))
            } catch (err) {
              if (err.code !== 'ENOENT') {
                throw err
              }
            }
          }
          index.insert({ filepath, stats, oid })
        }
      }
    )
    // TODO: return oid?
  } catch (err) {
    err.caller = 'git.reset'
    throw err
  }
}