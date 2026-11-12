import { format } from '../formats/minecraft/skin'
import { Dialog } from '../interface/dialog'
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

type SkinEditorDialogLabels = {
	settingsLabel: string
	settingsTitle: string
	autoSave: string
	autoSaveDescription: string
	interval: string
	intervalDescription: string
	warnBeforeLeave: string
	warnBeforeLeaveDescription: string
	recoveryTitle: string
	recoveryBody: string
	recoveryStartNew: string
	recoveryContinue: string
	unsavedTitle: string
	unsavedBody: string
	unsavedStay: string
	unsavedDiscard: string
	unsavedSave: string
}

type ParentCommand =
	| {
			type: 'axolotl-skin-config'
			autoSaveEnabled: boolean
			autoSaveIntervalSeconds: number
			warnBeforeLeave: boolean
	  }
	| ({type: 'axolotl-skin-labels'} & SkinEditorDialogLabels)
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
	| {
			type: 'axolotl-skin-prompt-unsaved'
			requestId: string
	  }

let autoSaveEnabled = true
let autoSaveIntervalSeconds = 30
let warnBeforeLeave = true
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
let fileNameElement: HTMLElement | null = null
let exportInProgress = false
let recoveryPromptPending = false
let recoveryPromptShown = false
let unsavedPromptOpen = false

const dialogLabels: SkinEditorDialogLabels = {
	settingsLabel: 'Skin editor settings',
	settingsTitle: 'Editor settings',
	autoSave: 'Automatically save a recovery draft',
	autoSaveDescription:
		'Recovery drafts stay on this device and are separate from exported PNG files.',
	interval: 'Save interval (seconds)',
	intervalDescription: 'Use a value between 5 and 600 seconds.',
	warnBeforeLeave: 'Warn before leaving with unsaved changes',
	warnBeforeLeaveDescription:
		'When auto-save is off, this warning is always enabled to protect your work.',
	recoveryTitle: 'Continue last skin?',
	recoveryBody: 'A recovery draft was saved on this device.',
	recoveryStartNew: 'Start new',
	recoveryContinue: 'Continue',
	unsavedTitle: 'Unsaved skin',
	unsavedBody: 'Save your skin before leaving, or discard the current changes.',
	unsavedStay: 'Stay',
	unsavedDiscard: 'Discard',
	unsavedSave: 'Save PNG',
}

const skinEditorSettingsItem = {
	id: 'axolotl_skin_settings',
	name: dialogLabels.settingsLabel,
	icon: 'settings',
	click() {
		openSettingsDialog()
	},
}

function postToParent(message: object): void {
	window.parent.postMessage(message, '*')
}

function publishState(autoSave: 'idle' | 'saving' | 'saved' | 'error' = 'idle'): void {
	updateFileNameLabel()
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
	if (exportInProgress) return false
	const texture = Texture.all[0]
	if (!texture) {
		Blockbench.showQuickMessage('No skin texture is available to save.', 3000)
		return false
	}

	exportInProgress = true
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
		exportInProgress = false
		autoSaveSuspended = false
		if (dirty) armAutoSaveTimer()
	}
}

function currentFileName(): string {
	const texture = Texture.all[0]
	if (!texture?.name) return ''
	return texture.name.toLowerCase().endsWith('.png') ? texture.name : `${texture.name}.png`
}

function updateFileNameLabel(): void {
	if (!fileNameElement) return
	const name = currentFileName()
	fileNameElement.textContent = name ? `${name}${dirty ? '*' : ''}` : ''
	fileNameElement.hidden = !name
}

function applyLabels(message: Partial<SkinEditorDialogLabels>): void {
	for (const key of Object.keys(dialogLabels) as (keyof SkinEditorDialogLabels)[]) {
		const value = message[key]
		if (typeof value === 'string' && value) dialogLabels[key] = value
	}
	skinEditorSettingsItem.name = dialogLabels.settingsLabel
	if (recoveryPromptPending) {
		recoveryPromptPending = false
		openRecoveryDialog()
	}
}

function setupSkinOnlyFileName(): void {
	fileNameElement = document.getElementById('axolotl_skin_file_name')
	updateFileNameLabel()
}

function openSettingsDialog(): void {
	new Dialog({
		id: 'axolotl_skin_settings',
		title: dialogLabels.settingsTitle,
		width: 560,
		form: {
			autoSaveEnabled: {
				type: 'checkbox',
				style: 'toggle_switch',
				label: dialogLabels.autoSave,
				description: dialogLabels.autoSaveDescription,
				value: autoSaveEnabled,
			},
			autoSaveIntervalSeconds: {
				type: 'number',
				label: dialogLabels.interval,
				description: dialogLabels.intervalDescription,
				value: autoSaveIntervalSeconds,
				min: 5,
				max: 600,
				step: 5,
			},
			warnBeforeLeave: {
				type: 'checkbox',
				style: 'toggle_switch',
				label: dialogLabels.warnBeforeLeave,
				description: dialogLabels.warnBeforeLeaveDescription,
				value: warnBeforeLeave || !autoSaveEnabled,
			},
		},
		onConfirm(result) {
			autoSaveEnabled = result.autoSaveEnabled === true
			autoSaveIntervalSeconds = clampInterval(Number(result.autoSaveIntervalSeconds))
			warnBeforeLeave = autoSaveEnabled ? result.warnBeforeLeave === true : true
			if (autoSaveEnabled) armAutoSaveTimer()
			else clearAutoSaveTimer()
			postToParent({
				type: 'axolotl-skin-settings-change',
				autoSaveEnabled,
				autoSaveIntervalSeconds,
				warnBeforeLeave,
			})
		},
	}).show()
}

function openRecoveryDialog(): void {
	if (!currentRecovery || recoveryPromptShown) return
	recoveryPromptShown = true
	let body = dialogLabels.recoveryBody
	if (!body) {
		try {
			body = `A recovery draft was saved on ${new Date(currentRecovery.updatedAt).toLocaleString()}.`
		} catch {
			body = 'A recovery draft was saved on this device.'
		}
	}
	new Dialog({
		id: 'axolotl_skin_recovery',
		title: dialogLabels.recoveryTitle,
		width: 480,
		lines: [body],
		buttons: [dialogLabels.recoveryStartNew, dialogLabels.recoveryContinue],
		confirmIndex: 1,
		cancelIndex: 2,
		cancel_on_click_outside: false,
		onBuild(object) {
			object.querySelector('.dialog_close_button')?.remove()
		},
		onCancel() {
			return false
		},
		onButton(button) {
			window.setTimeout(() => {
				if (button === 1) void restoreDraft()
				else void startNewSkin()
			}, 0)
		},
	}).show()
}

function openUnsavedPrompt(requestId: string): void {
	if (unsavedPromptOpen) {
		postToParent({type: 'axolotl-skin-prompt-result', requestId, choice: 'stay'})
		return
	}
	unsavedPromptOpen = true
	new Dialog({
		id: 'axolotl_skin_unsaved',
		title: dialogLabels.unsavedTitle,
		width: 480,
		lines: [dialogLabels.unsavedBody],
		buttons: [dialogLabels.unsavedStay, dialogLabels.unsavedDiscard, dialogLabels.unsavedSave],
		confirmIndex: 2,
		cancelIndex: 3,
		cancel_on_click_outside: false,
		onBuild(object) {
			object.querySelector('.dialog_close_button')?.remove()
		},
		onCancel() {
			return false
		},
		onButton(button) {
			const choice = button === 2 ? 'save' : button === 1 ? 'discard' : 'stay'
			window.setTimeout(() => {
				unsavedPromptOpen = false
				postToParent({type: 'axolotl-skin-prompt-result', requestId, choice})
			}, 0)
		},
	}).show()
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
		if (typeof message.warnBeforeLeave === 'boolean') {
			warnBeforeLeave = message.warnBeforeLeave
		}
		if (autoSaveEnabled) armAutoSaveTimer()
		else clearAutoSaveTimer()
		return
	}

	if (message.type === 'axolotl-skin-labels') {
		applyLabels(message)
		return
	}

	if (
		message.type === 'axolotl-skin-prompt-unsaved' &&
		typeof message.requestId === 'string'
	) {
		openUnsavedPrompt(message.requestId)
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
	setupSkinOnlyFileName()
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
	new BarMenu('edit', [
		'undo',
		'redo',
		new MenuSeparator('clipboard'),
		'cut',
		'copy',
		'paste',
		new MenuSeparator('axolotl'),
		skinEditorSettingsItem,
	])
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
	Blockbench.on('select_project', updateFileNameLabel)
	Blockbench.on('new_project', updateFileNameLabel)

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
		if (currentRecovery) {
			recoveryPromptPending = true
			window.setTimeout(() => {
				if (!recoveryPromptPending) return
				recoveryPromptPending = false
				openRecoveryDialog()
			}, 1500)
		} else {
			openRequiredInitialDialog()
		}
	})
})
