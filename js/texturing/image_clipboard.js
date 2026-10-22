/** Keeps image selections available inside the editor when system clipboard access fails. */
export class ImageClipboard {
    local = null;

    write(image) {
        const bytes = Uint8Array.from(atob(image.data.split(',')[1]), char => char.charCodeAt(0));
        const blob = new Blob([bytes], {type: 'image/png'});
        const local = {image: {...image}, system: false};
        this.local = local;

        // Call write synchronously during the user's gesture, before any asynchronous encoding.
        try {
            return Promise.resolve(navigator.clipboard.write([
                new ClipboardItem({'image/png': blob}),
            ])).then(() => {
                local.system = true;
                return true;
            }, () => false);
        } catch {
            return Promise.resolve(false);
        }
    }

    async read() {
        const local = this.local;
        // A failed or pending write must not paste unrelated, older system clipboard content.
        if (local && !local.system) return {data: local.image.data, image: local.image};

        let items;
        try {
            items = await navigator.clipboard.read();
        } catch (error) {
            if (local) return {data: local.image.data, image: local.image};
            throw error;
        }
        const item = items.find(item => item.types.includes('image/png'));
        if (!item) {
            // Some WebViews resolve read() without exposing any clipboard formats.
            if (local && !items.some(item => item.types.length)) {
                return {data: local.image.data, image: local.image};
            }
            return null;
        }

        const blob = await item.getType('image/png');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const data = `data:image/png;base64,${btoa(binary)}`;
        // The painter compares decoded pixels before reusing this selection's position.
        return {data, image: local?.image};
    }
}
