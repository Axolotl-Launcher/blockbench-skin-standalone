const DATABASE_NAME = 'auto_backups'
const STORE_NAME = 'projects'
const DRAFT_KEY = 'axolotl-skin-editor-draft'

export type SkinEditorDraft = {
	uuid: string
	projectId: string
	data: string
	name?: string
	updatedAt: number
}

let databasePromise: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
	if (databasePromise) return databasePromise

	const opening = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, 1)
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME, {keyPath: 'uuid'})
			}
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
		request.onblocked = () => reject(new Error('Skin editor draft database is blocked'))
	})
	databasePromise = opening
	void opening.catch(() => {
		if (databasePromise === opening) databasePromise = undefined
	})
	return opening
}

function transact<T>(
	mode: IDBTransactionMode,
	action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return openDatabase().then(
		database =>
			new Promise((resolve, reject) => {
				const transaction = database.transaction(STORE_NAME, mode)
				const request = action(transaction.objectStore(STORE_NAME))
				let result: T
				request.onsuccess = () => {
					result = request.result
				}
				request.onerror = () => reject(request.error)
				transaction.onerror = () => reject(transaction.error)
				transaction.onabort = () => reject(transaction.error ?? new Error('Draft transaction aborted'))
				transaction.oncomplete = () => resolve(result)
			}),
	)
}

export async function readSkinEditorDraft(): Promise<SkinEditorDraft | undefined> {
	const draft = await transact<SkinEditorDraft | undefined>('readonly', store =>
		store.get(DRAFT_KEY),
	)
	if (
		!draft ||
		typeof draft.projectId !== 'string' ||
		typeof draft.data !== 'string' ||
		typeof draft.updatedAt !== 'number' ||
		!Number.isFinite(draft.updatedAt) ||
		(draft.name !== undefined && typeof draft.name !== 'string')
	) {
		await clearSkinEditorDraft()
		return undefined
	}
	return draft
}

export async function writeSkinEditorDraft(): Promise<number> {
	if (!Project) throw new Error('No skin project is open')
	const updatedAt = Date.now()
	const data = JSON.stringify(
		Codecs.project.compile({compressed: false, backup: true, raw: true}),
	)
	const draft: SkinEditorDraft = {
		uuid: DRAFT_KEY,
		projectId: Project.uuid,
		data,
		name: Project.name || undefined,
		updatedAt,
	}
	await transact('readwrite', store => store.put(draft))
	return updatedAt
}

export async function clearSkinEditorDraft(): Promise<void> {
	await transact('readwrite', store => store.delete(DRAFT_KEY))
}
