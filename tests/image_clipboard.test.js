import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {ImageClipboard} from '../js/texturing/image_clipboard.js';

const data = 'data:image/png;base64,AQID';
const image = {data, x: 8, y: 12, frame: 0};
const denied = new DOMException('Clipboard access denied', 'NotAllowedError');
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');

function setClipboard(clipboard) {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard}});
}

function pngItem(bytes = [1, 2, 3]) {
    return {types: ['image/png'], getType: async () => new Blob([new Uint8Array(bytes)])};
}

beforeEach(() => {
    Object.defineProperty(globalThis, 'ClipboardItem', {
        configurable: true,
        value: class {
            constructor(content) { this.content = content; }
        },
    });
});

afterEach(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (clipboardItemDescriptor) Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor);
    else delete globalThis.ClipboardItem;
});

test('starts the system write during the gesture and exports the exact PNG bytes', async () => {
    let written;
    setClipboard({write: items => { written = items[0].content['image/png']; }});
    const clipboard = new ImageClipboard();
    const pending = clipboard.write(image);
    assert.ok(written instanceof Blob);
    assert.equal(written.type, 'image/png');
    assert.deepEqual([...new Uint8Array(await written.arrayBuffer())], [1, 2, 3]);
    assert.equal(await pending, true);
});

test('keeps a copy immediately while the system write is pending', async () => {
    let complete;
    setClipboard({write: () => new Promise(resolve => { complete = resolve; })});
    const clipboard = new ImageClipboard();
    const pending = clipboard.write(image);
    assert.deepEqual(await clipboard.read(), {data, image});
    complete();
    await pending;
});

test('a denied write pastes the copied selection instead of stale system content', async () => {
    let reads = 0;
    setClipboard({
        write: () => Promise.reject(denied),
        read: async () => { reads++; return [pngItem([9])]; },
    });
    const clipboard = new ImageClipboard();
    assert.equal(await clipboard.write(image), false);
    assert.deepEqual(await clipboard.read(), {data, image});
    assert.equal(reads, 0);
});

test('copy and paste still work when browser clipboard APIs are absent', async () => {
    setClipboard(undefined);
    const clipboard = new ImageClipboard();
    assert.equal(await clipboard.write(image), false);
    assert.deepEqual(await clipboard.read(), {data, image});
});

test('a denied read can recover a previously copied selection', async () => {
    setClipboard({write: async () => {}, read: () => Promise.reject(denied)});
    const clipboard = new ImageClipboard();
    assert.equal(await clipboard.write(image), true);
    assert.deepEqual(await clipboard.read(), {data, image});
});

test('a denied read with no local copy reports failure', async () => {
    setClipboard({read: () => Promise.reject(denied)});
    await assert.rejects(new ImageClipboard().read(), error => error === denied);
});

test('external PNG images replace the local content', async () => {
    setClipboard({write: async () => {}, read: async () => [pngItem([9, 8, 7])]});
    const clipboard = new ImageClipboard();
    await clipboard.write(image);
    assert.deepEqual(await clipboard.read(), {data: 'data:image/png;base64,CQgH', image});
});

test('the same system PNG retains selection position and animation frame', async () => {
    setClipboard({write: async () => {}, read: async () => [pngItem()]});
    const clipboard = new ImageClipboard();
    await clipboard.write(image);
    assert.deepEqual(await clipboard.read(), {data, image});
});

test('finds PNG content beyond the first clipboard item', async () => {
    setClipboard({read: async () => [{types: ['text/plain']}, pngItem()]});
    assert.equal((await new ImageClipboard().read()).data, data);
});

test('a readable clipboard with no PNG does not paste an old local selection', async () => {
    setClipboard({write: async () => {}, read: async () => [{types: ['text/plain']}]});
    const clipboard = new ImageClipboard();
    await clipboard.write(image);
    assert.equal(await clipboard.read(), null);
});

test('a WebView that exposes no clipboard formats still pastes the local selection', async () => {
    setClipboard({write: async () => {}, read: async () => [{types: []}]});
    const clipboard = new ImageClipboard();
    await clipboard.write(image);
    assert.deepEqual(await clipboard.read(), {data, image});
});

test('an older pending write cannot overwrite a newer copied selection', async () => {
    let complete;
    setClipboard({write: () => new Promise(resolve => { complete = resolve; })});
    const clipboard = new ImageClipboard();
    const pending = clipboard.write(image);
    setClipboard(undefined);
    const newer = {...image, x: 24, data: 'data:image/png;base64,BAUG'};
    await clipboard.write(newer);
    complete();
    await pending;
    assert.deepEqual(await clipboard.read(), {data: newer.data, image: newer});
});

function paintingHandlers(clipboard, texture, globals = {}) {
    const source = readFileSync(new URL('../js/texturing/painter.js', import.meta.url), 'utf8');
    const handlers = {};
    const messages = [];
    const sandbox = {
        imageClipboard: clipboard,
        UVEditor: {texture},
        Prop: {active_panel: 'uv'},
        Modes: {paint: true},
        Clipbench: {},
        Project: {},
        isApp: false,
        console: {error() {}},
        showClipboardMessage: key => messages.push(key),
        SharedActions: {
            add: (action, handler) => { handlers[action] = handler; },
            runSpecific: () => { texture.deleted = true; },
        },
        ...globals,
    };
    runInNewContext(source.slice(source.indexOf("SharedActions.add('copy', {"), source.indexOf("SharedActions.add('duplicate', {")), sandbox);
    return {handlers, sandbox, messages};
}

test('cut saves the selected pixels before deletion even if system access is denied', async () => {
    setClipboard(undefined);
    const clipboard = new ImageClipboard();
    const texture = {
        selection: {override: true}, currentFrame: 0,
        getActiveCanvas: () => ({canvas: {toDataURL: () => data}, offset: [8, 12]}),
    };
    const {handlers} = paintingHandlers(clipboard, texture);
    handlers.copy.run({}, true);
    assert.equal(texture.deleted, true);
    assert.deepEqual(await clipboard.read(), {data, image});
});

test('cut keeps the selected pixels if saving the local copy fails', () => {
    const texture = {
        selection: {override: true}, currentFrame: 0,
        getActiveCanvas: () => ({canvas: {toDataURL: () => data}, offset: [0, 0]}),
    };
    const {handlers, messages} = paintingHandlers({write() { throw new Error('Cannot save'); }}, texture);
    handlers.copy.run({}, true);
    assert.equal(texture.deleted, undefined);
    assert.deepEqual(messages, ['message.clipboard.copy_failed']);
});

test('paste reports denied clipboard access instead of silently doing nothing', async () => {
    setClipboard({read: () => Promise.reject(denied)});
    const {handlers, messages} = paintingHandlers(new ImageClipboard(), {});
    await handlers.paste.run({});
    assert.deepEqual(messages, ['message.clipboard.paste_failed']);
});

for (const samePixels of [true, false]) {
    test(samePixels ? 'paste retains selection position after the system re-encodes a PNG' : 'an external image does not inherit the last selection position', async () => {
        let pasted;
        const texture = {
            width: 64, height: 64, layers_enabled: true,
            select() { this.selected = true; },
            updateChangesAfterEdit() {},
        };
        const {handlers, messages} = paintingHandlers({
            read: async () => ({data: 'system-png', image: {...image, data: 'local-png'}}),
        }, texture, {
            CanvasFrame: class {
                width = 2;
                height = 1;
                async loadFromURL(source) {
                    this.ctx = {getImageData: () => ({data: new Uint8Array(source === 'local-png' || samePixels ? [255, 0, 0, 255] : [0, 0, 255, 255])})};
                }
            },
            TextureLayer: class {
                constructor(options) { pasted = this; Object.assign(this, options); this.ctx = {putImageData() {}}; }
                setSize() {}
                center() { this.centered = true; }
                addForEditing() {}
                setLimbo() {}
            },
            Math: {clamp: (value, min, max) => Math.max(min, Math.min(max, value))},
            Undo: {
                initEdit() { assert.equal(texture.selected, true); },
                finishEdit() {},
            },
            Toolbox: {selected: {id: 'selection_tool'}},
            updateInterfacePanels() {},
            BARS: {updateConditions() {}},
        });
        await handlers.paste.run({});
        assert.deepEqual(messages, []);
        if (samePixels) {
            assert.deepEqual(Array.from(pasted.offset), [8, 12]);
            assert.equal(pasted.centered, undefined);
        } else {
            assert.equal(pasted.offset, undefined);
            assert.equal(pasted.centered, true);
        }
    });
}
