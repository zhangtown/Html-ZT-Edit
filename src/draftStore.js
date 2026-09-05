// 本地草稿存储：使用 IndexedDB（非 localStorage，避免图片体积超限）
// 仅存于用户本机，刷新后可自动恢复编辑进度。
const DB_NAME = 'ztedit-drafts'
const STORE = 'drafts'
const KEY = 'current'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// data: { html, assets:[{val, blob}], scripts:[...], current, savedAt, v }
export async function saveDraft(data) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    let settled = false
    const done = (fn, v) => () => { if (!settled) { settled = true; fn(v) } }
    tx.objectStore(STORE).put(data, KEY)
    tx.oncomplete = done(resolve)
    // 配额超限（QuotaExceededError）会让事务 abort。只监听 onerror 会漏掉它：
    // 事务中止而 promise 永不 settle，actuallySave 会一直 await 住，
    // 之后每一次自动保存都被这条死链卡住，用户却看到「一切正常」。
    tx.onabort = done(reject, tx.error || new Error('草稿写入事务被中止（可能超出浏览器存储配额）'))
    tx.onerror = done(reject, tx.error || new Error('草稿写入失败'))
  })
}

export async function loadDraft() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    let settled = false
    const done = (fn, v) => () => { if (!settled) { settled = true; fn(v) } }
    const r = tx.objectStore(STORE).get(KEY)
    // r.result 必须在请求自身的 onsuccess 里读：在 tx.oncomplete 挂载处写
    // done(resolve, r.result || null) 会对尚未完成的请求同步读 result，
    // 抛 InvalidStateError，草稿恢复从未生效（挂载处空 catch 吞掉）
    r.onsuccess = () => { if (!settled) { settled = true; resolve(r.result || null) } }
    tx.onabort = done(reject, tx.error || new Error('草稿读取事务被中止'))
    tx.onerror = done(reject, tx.error || new Error('草稿读取失败'))
  })
}

export async function clearDraft() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    let settled = false
    const done = (fn, v) => () => { if (!settled) { settled = true; fn(v) } }
    tx.objectStore(STORE).delete(KEY)
    tx.oncomplete = done(resolve)
    tx.onabort = done(reject, tx.error || new Error('草稿删除事务被中止'))
    tx.onerror = done(reject, tx.error || new Error('草稿删除失败'))
  })
}
