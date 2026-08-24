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

// data: { html, assets:[{val, blob}], scripts:[...], current, savedAt }
export async function saveDraft(data) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(data, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function loadDraft() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(KEY)
    r.onsuccess = () => resolve(r.result || null)
    r.onerror = () => reject(r.error)
  })
}

export async function clearDraft() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
