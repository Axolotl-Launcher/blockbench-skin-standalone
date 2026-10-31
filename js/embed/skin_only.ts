import { format } from '../formats/minecraft/skin'
import { BarMenu, MenuBar } from '../interface/menu_bar'
import { resizeWindow } from '../interface/interface'
import { setActivePanel } from '../interface/panels'
import { setStartScreen, setupProject } from '../io/project'
import { onVueSetup } from '../util/util'
import {
	clearSkinEditorDraft,
	readSkinEditorDraft,
	writeSkinEditorDraft,
	type SkinEditorDraft,
} from './skin_draft'

function shouldKeepRecoveryDraftAfterExport(
	exportedRevision: number,
	currentRevision: number,
): boolean {
	return exportedRevision !== currentRevision
}

const axolotlThemeColors = [
	'ui',
	'back',
	'dark',
	'border',
	'selected',
	'elevated',
	'button',
	'bright_ui',
	'accent',
	'accent_highlight',
	'focus_ring',
	'hover',
	'frame',
	'text',
	'light',
	'accent_text',
	'bright_ui_text',
	'subtle_text',
	'grid',
	'wireframe',
	'checkerboard',
	'menu_separator',
	'bright_border',
] as const

const axolotlThemeMetrics = [
	'gap-xs',
	'gap-sm',
	'gap-md',
	'gap-lg',
	'radius-xs',
	'radius-sm',
	'radius-md',
] as const

type AxolotlThemeMessage = {
	type: 'axolotl-skin-theme'
	theme: {
		dark: boolean
		colors: Record<string, string>
		metrics: Record<string, string>
	}
}

type ParentCommand =
	| {
			type: 'axolotl-skin-config'
			autoSaveEnabled: boolean
			autoSaveIntervalSeconds: number
	  }
	| {
			type: 'axolotl-skin-command'
			requestId: string
			command: 'flush-draft' | 'discard-draft' | 'restore-draft' | 'start-new' | 'request-export'
			reason?: 'manual' | 'leave'
	  }
	| {
			type: 'axolotl-skin-export-result'
			requestId: string
			saved: boolean
	  }
	| {
			type: 'axolotl-skin-export-accepted'
			requestId: string
			accepted: boolean
	  }

let autoSaveEnabled = true
let autoSaveIntervalSeconds = 30
let autoSaveTimer: ReturnType<typeof setTimeout> | undefined
let autoSavePromise: Promise<boolean> | undefined
let autoSaveSuspended = false
let dirty = false
let dirtyRevision = 0
let lastDraftSavedAt: number | undefined
let currentRecovery: SkinEditorDraft | undefined
let requestCounter = 0
const pendingExports = new Map<string, (saved: boolean) => void>()
const pendingExportAccepts = new Map<string, (accepted: boolean) => void>()

function postToParent(message: object): void {
	window.parent.postMessage(message, '*')
}

function publishState(autoSave: 'idle' | 'saving' | 'saved' | 'error' = 'idle'): void {
	postToParent({
		type: 'axolotl-skin-state',
		dirty,
		autoSave,
		...(lastDraftSavedAt ? {lastSavedAt: lastDraftSavedAt} : {}),
	})
}

function clampInterval(value: number): number {
	return Number.isFinite(value) ? Math.min(600, Math.max(5, Math.round(value))) : 30
}

function clearAutoSaveTimer(): void {
	if (autoSaveTimer !== undefined) clearTimeout(autoSaveTimer)
	autoSaveTimer = undefined
}

function armAutoSaveTimer(): void {
	clearAutoSaveTimer()
	if (!autoSaveEnabled || autoSaveSuspended || !dirty || !Project) return
	autoSaveTimer = setTimeout(() => {
		autoSaveTimer = undefined
		void flushDraft(false)
	}, autoSaveIntervalSeconds * 1000)
}

function setDirty(nextDirty: boolean): void {
	dirty = nextDirty
	if (dirty) dirtyRevision += 1
	if (!dirty) {
		clearAutoSaveTimer()
	} else {
		armAutoSaveTimer()
	}
	publishState()
}

async function flushDraft(force: boolean): Promise<boolean> {
	if (!Project || (!force && !dirty)) return true
	if (autoSavePromise) return await autoSavePromise

	autoSaveSuspended = true
	clearAutoSaveTimer()
	publishState('saving')
	autoSavePromise = (async () => {
		try {
			lastDraftSavedAt = await writeSkinEditorDraft()
			publishState('saved')
			return true
		} catch (error) {
			console.error('Failed to save skin editor recovery draft', error)
			publishState('error')
			return false
		} finally {
			autoSavePromise = undefined
			autoSaveSuspended = false
			if (dirty && autoSaveEnabled) armAutoSaveTimer()
		}
	})()
	return await autoSavePromise
}

function nextRequestId(): string {
	requestCounter += 1
	return `blockbench-${Date.now()}-${requestCounter}`
}

async function requestExport(
	reason: 'manual' | 'leave',
	requestId = nextRequestId(),
): Promise<boolean> {
	const texture = Texture.all[0]
	if (!texture) {
		Blockbench.showQuickMessage('No skin texture is available to save.', 3000)
		return false
	}

	clearAutoSaveTimer()
	if (autoSavePromise) await autoSavePromise
	autoSaveSuspended = true
	clearAutoSaveTimer()
	const exportedRevision = dirtyRevision

	try {
		const accepted = await new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				pendingExportAccepts.delete(requestId)
				resolve(false)
			}, 15_000)
			pendingExportAccepts.set(requestId, value => {
				clearTimeout(timeout)
				pendingExportAccepts.delete(requestId)
				resolve(value)
			})
			postToParent({
				type: 'axolotl-skin-export-request',
				requestId,
				name: texture.name.endsWith('.png') ? texture.name : `${texture.name}.png`,
				dataUrl: texture.getDataURL(),
				reason,
			})
		})
		if (!accepted) {
			Blockbench.showQuickMessage('The launcher could not accept the exported skin.', 4000)
			return false
		}

		const saved = await new Promise<boolean>(resolve => {
			let settled = false
			const finish = (value: boolean) => {
				if (settled) return
				settled = true
				pendingExports.delete(requestId)
				resolve(value)
			}
			const timeout = setTimeout(() => finish(false), 60_000)
			pendingExports.set(requestId, value => {
				clearTimeout(timeout)
				finish(value)
			})
		})

		if (!saved || !Project) return false
		if (shouldKeepRecoveryDraftAfterExport(exportedRevision, dirtyRevision)) {
			Blockbench.showQuickMessage(
				'The previous version was saved. Newer changes are still unsaved.',
				4000,
			)
			return false
		}

		Project.saved = true
		await clearSkinEditorDraft()
		if (shouldKeepRecoveryDraftAfterExport(exportedRevision, dirtyRevision)) {
			Project.saved = false
			await flushDraft(true)
			return false
		}
		lastDraftSavedAt = undefined
		setDirty(false)
		publishState('idle')
		return true
	} catch (error) {
		console.error('Failed to export skin', error)
		Blockbench.showQuickMessage('The skin could not be prepared for saving.', 4000)
		return false
	} finally {
		autoSaveSuspended = false
		if (dirty) armAutoSaveTimer()
	}
}

async function startNewSkin(): Promise<void> {
	clearAutoSaveTimer()
	autoSaveSuspended = true
	try {
		if (autoSavePromise) await autoSavePromise
		if (Project) {
			Project.saved = true
			await Project.close(true)
		}
		await clearSkinEditorDraft()
		currentRecovery = undefined
		lastDraftSavedAt = undefined
		dirty = false
		openRequiredInitialDialog()
		publishState('idle')
	} finally {
		autoSaveSuspended = false
	}
}

async function restoreDraft(): Promise<boolean> {
	const draft = currentRecovery ?? (await readSkinEditorDraft())
	if (!draft) return false

	let parsed: unknown
	try {
		parsed = JSON.parse(draft.data)
	} catch (error) {
		console.error('Skin editor recovery draft is not valid JSON', error)
		await clearSkinEditorDraft()
		currentRecovery = undefined
		openRequiredInitialDialog()
		return false
	}
	if (!parsed || typeof parsed !== 'object') {
		await clearSkinEditorDraft()
		currentRecovery = undefined
		openRequiredInitialDialog()
		return false
	}

	try {
		if (Project) {
			Project.saved = true
			await Project.close(true)
		}
		setupProject(format, draft.projectId)
		Codecs.project.parse(parsed, 'skin-recovery.bbmodel')
		setActivePanel('uv')
		resizeWindow()
		currentRecovery = undefined
		Project.saved = false
		autoSaveSuspended = false
		setDirty(true)
		return true
	} catch (error) {
		console.error('Failed to restore skin editor draft', error)
		openRequiredInitialDialog()
		return false
	}
}

async function handleCommand(message: Extract<ParentCommand, {type: 'axolotl-skin-command'}>) {
	let ok = false
	try {
		switch (message.command) {
			case 'flush-draft':
				ok = await flushDraft(true)
				break
			case 'discard-draft':
				await clearSkinEditorDraft()
				currentRecovery = undefined
				lastDraftSavedAt = undefined
				clearAutoSaveTimer()
				setDirty(false)
				ok = true
				break
			case 'restore-draft':
				ok = await restoreDraft()
				break
			case 'start-new':
				await startNewSkin()
				ok = true
				break
			case 'request-export':
				ok = await requestExport(message.reason ?? 'leave', message.requestId)
				break
		}
	} catch (error) {
		console.error(`Skin editor command failed: ${message.command}`, error)
		ok = false
	} finally {
		autoSaveSuspended = false
		if (dirty) armAutoSaveTimer()
		postToParent({type: 'axolotl-skin-command-result', requestId: message.requestId, ok})
	}
}

function handleAxolotlMessage(event: MessageEvent<unknown>): void {
	if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return
	const message = event.data as ParentCommand

	if (message.type === 'axolotl-skin-config') {
		autoSaveEnabled = message.autoSaveEnabled === true
		autoSaveIntervalSeconds = clampInterval(message.autoSaveIntervalSeconds)
		if (autoSaveEnabled) armAutoSaveTimer()
		else clearAutoSaveTimer()
		return
	}

	if (message.type === 'axolotl-skin-export-result') {
		pendingExports.get(message.requestId)?.(message.saved === true)
		return
	}

	if (message.type === 'axolotl-skin-export-accepted') {
		pendingExportAccepts.get(message.requestId)?.(message.accepted === true)
		return
	}

	if (
		message.type === 'axolotl-skin-command' &&
		typeof message.requestId === 'string' &&
		typeof message.command === 'string'
	) {
		void handleCommand(message)
	}
}

function applyAxolotlTheme(event: MessageEvent<unknown>): void {
	if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return
	const message = event.data as Partial<AxolotlThemeMessage>
	if (
		message.type !== 'axolotl-skin-theme' ||
		!message.theme ||
		typeof message.theme.dark !== 'boolean' ||
		!message.theme.colors ||
		!message.theme.metrics
	)
		return

	for (const color of axolotlThemeColors) {
		const value = message.theme.colors[color]
		if (typeof value === 'string' && value)
			document.body.style.setProperty(`--color-${color}`, value)
	}
	for (const metric of axolotlThemeMetrics) {
		const value = message.theme.metrics[metric]
		if (typeof value === 'string' && value)
			document.body.style.setProperty(`--axolotl-${metric}`, value)
	}
	document.body.classList.toggle('axolotl_dark_theme', message.theme.dark)
	document.body.classList.toggle('axolotl_light_theme', !message.theme.dark)
	document.documentElement.style.colorScheme = message.theme.dark ? 'dark' : 'light'
}

/**
 * Restricts the existing Blockbench workbench to Minecraft player skin work.
 * The painter, UV editor, preview, and undo stack remain Blockbench's native
 * implementations; only unrelated format and workspace entry points are removed.
 */
export function isSkinOnlyEmbed(): boolean {
	return Blockbench.queries?.embed === 'skin'
}

let unlockInitialDialog: (() => void) | undefined

function openRequiredInitialDialog() {
	const originalCancel = format.setup_dialog.cancel.bind(format.setup_dialog)
	const originalCancelOnClickOutside = format.setup_dialog.cancel_on_click_outside
	format.setup_dialog.cancel_on_click_outside = false
	format.setup_dialog.cancel = () => {}
	unlockInitialDialog = () => {
		format.setup_dialog.cancel = originalCancel
		format.setup_dialog.cancel_on_click_outside = originalCancelOnClickOutside
	}
	format.new()
	window.requestAnimationFrame(() => {
		format.setup_dialog.object?.querySelector('.cancel_btn')?.remove()
		format.setup_dialog.object?.querySelector('.dialog_close_button')?.remove()
	})
}

function requestNewSkin() {
	if (dirty) {
		postToParent({type: 'axolotl-skin-new-skin-request'})
		return
	}
	void startNewSkin()
}

export function setupSkinOnlyEmbed(): void {
	if (!isSkinOnlyEmbed()) return

	document.body.classList.add('skin_only_embed')
	window.addEventListener('message', applyAxolotlTheme)
	window.addEventListener('message', handleAxolotlMessage)
	document.getElementById('skin_only_attribution').hidden = false
	for (const id of Object.keys(MenuBar.menus)) {
		MenuBar.menus[id].delete()
	}

	new BarMenu('file', [
		{
			id: 'new_minecraft_skin',
			name: 'dialog.skin.title',
			icon: 'icon-player',
			click: requestNewSkin,
		},
		new MenuSeparator('export'),
		'export_minecraft_skin',
	])
	new BarMenu('edit', ['undo', 'redo', new MenuSeparator('clipboard'), 'cut', 'copy', 'paste'])
	new BarMenu('skin', [
		'custom_skin_poses',
		'add_custom_skin_pose',
		new MenuSeparator('edit'),
		'toggle_skin_layer',
		'explode_skin_model',
		'convert_minecraft_skin_variant',
	])
	new BarMenu('image', [
		'adjust_brightness_contrast',
		'adjust_saturation_hue',
		'adjust_opacity',
		'invert_colors',
		new MenuSeparator('transform'),
		'flip_texture_x',
		'flip_texture_y',
		'rotate_texture_cw',
		'rotate_texture_ccw',
	])
	MenuBar.update()
	const onConfirm = format.setup_dialog.onConfirm
	format.setup_dialog.onConfirm = function (...args) {
		const result = onConfirm.apply(this, args)
		if (result !== false) {
			unlockInitialDialog?.()
			unlockInitialDialog = undefined
			window.requestAnimationFrame(() => {
				format.setup_dialog.hide()
				setActivePanel('uv')
				resizeWindow()
				Project.saved = true
				autoSaveSuspended = false
				lastDraftSavedAt = undefined
				setDirty(false)
			})
		}
		return result
	}

	Blockbench.on('saved_state_changed', event => {
		if (event.project === Project) setDirty(!event.saved)
	})

	Blockbench.skinOnlyEmbed = {
		openRequiredInitialDialog,
		requestExport,
		flushDraft,
		clearSkinEditorDraft,
	}
}

onVueSetup(() => {
	if (!isSkinOnlyEmbed()) return
	setStartScreen(false)
	window.requestAnimationFrame(async () => {
		resizeWindow()
		try {
			currentRecovery = await readSkinEditorDraft()
		} catch (error) {
			console.error('Failed to read skin editor recovery draft', error)
			currentRecovery = undefined
		}
		postToParent({
			type: 'axolotl-skin-theme-ready',
			...(currentRecovery
				? {
						recovery: {
							updatedAt: currentRecovery.updatedAt,
							...(currentRecovery.name ? {name: currentRecovery.name} : {}),
						},
					}
				: {}),
		})
		if (!currentRecovery) openRequiredInitialDialog()
	})
})
