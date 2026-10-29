import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Blob} from 'node:buffer';
import {EventEmitter} from 'node:events';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.equal(html, await readFile(new URL('../гиф редактор.txt', import.meta.url), 'utf8'));
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
for (const script of scripts) new vm.Script(script);
const decoder = vm.createContext({window: {}});
vm.runInContext(scripts[1], decoder);
const {parseGIF, decompressFrame} = decoder.window.gifuct;
const helperStart = scripts[2].indexOf('function encodeFrame(');
const helpers = vm.createContext({Blob, setTimeout, clearTimeout});
vm.runInContext(scripts[2].slice(helperStart, scripts[2].indexOf("$('btnProcess').onclick", helperStart)), helpers);
const events = new EventEmitter();
const workerContext = vm.createContext({self: {postMessage(result, transfers) {
    events.emit('message', {data: structuredClone(result, {transfer: transfers})});
}}});
vm.runInContext(JSON.parse(html.match(/const GIF_WORKER_SOURCE = ("[^\n]*");/)[1]), workerContext);
const worker = {
    addEventListener: events.on.bind(events),
    removeEventListener: events.off.bind(events),
    postMessage(task, transfers) {
        const data = structuredClone(task, {transfer: transfers});
        queueMicrotask(() => workerContext.self.onmessage({data}));
    }
};
async function encode(task) {
    const data = task.data;
    const result = await helpers.encodeFrame(worker, {
        quality: 1, repeat: 0, dither: false, canTransfer: true, delay: 100,
        transparent: 0xff00ff, ...task
    });
    assert.equal(data.byteLength, 0, 'RGBA buffer must be transferred, not retained');
    assert.equal(events.listenerCount('message'), 0);
    assert.equal(events.listenerCount('error'), 0);
    return result;
}
async function decode(parts) {
    const bytes = await new Blob(parts).arrayBuffer();
    assert.equal(new Uint8Array(bytes).at(-1), 0x3b);
    const gif = parseGIF(bytes);
    return {gif, frames: gif.frames.filter(f => f.image).map(f => decompressFrame(f, gif.gct, true))};
}
const timeline = vm.createContext({});
vm.runInContext(scripts[2].slice(scripts[2].indexOf('function videoExportFrames('),scripts[2].indexOf('// Encode one frame at a time:')), timeline);
for (const fps of [10,15,20,24]) {
    const schedule = timeline.videoExportFrames(.25, 5.338, fps);
    assert.equal(schedule.length, Math.ceil(5.088 * fps));
    assert(Math.abs(schedule.reduce((sum,f) => sum+f.delay,0)-5088) <= 10);
    for (let i=0;i<schedule.length;i++) {
        assert(Math.abs(schedule[i].time-(.25+i/fps)) < 1e-10, 'sampling must not accumulate timing error');
        assert.equal(schedule[i].delay % 10, 0);
    }
}
// Opaque magenta must remain opaque, even beside transparent pixels with the same RGB.
// Unchanging pixels must decode to identical colours as other parts of the frame change.
const colours = [[255,0,255], [120,180,100], [255,0,0], [0,255,0], [0,0,255]];
const sample = new Uint8ClampedArray(500 * 4);
for (let i = 0; i < 500; i++) sample.set([...colours[i % colours.length], 255], i * 4);
const paletteResult = await encode({index: 0, last: true, width: 500, height: 1, globalPalette: true, transparent: null, data: sample});
const palette = paletteResult.globalPalette;
assert.equal(palette.length, 768);
const parts = [], delays = [40,130,270,100];
for (let index = 0; index < 4; index++) {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let p = 0; p < 64 * 64; p++) data.set([...colours[2 + index % 3], 255], p * 4);
    data.set([255,0,255,255], 0);
    data.set([255,0,255,0], 4);
    data.set([120,180,100,255], 8);
    // A moving transparent area must clear, then be painted by an opaque frame.
    if (index === 1) for (let p = 10; p < 30; p++) data[p * 4 + 3] = 0;
    if (index === 2) for (let p = 0; p < 64 * 64; p++) data[p * 4 + 3] = 0;
    const encoded = await encode({index, last: index === 3, width: 64, height: 64, delay: delays[index], globalPalette: palette, data});
    parts.push(helpers.encodedFrameBlob(encoded));
}
const {gif, frames} = await decode(parts);
assert.equal(frames.length, 4);
assert.equal(gif.lsd.width, 64);
for (let i = 0; i < frames.length; i++) {
    assert.equal(frames[i].delay, delays[i]);
    assert.equal(frames[i].disposalType, 2);
    assert.equal(frames[i].patch[7], 0);
    if (i !== 2) {
        assert.equal(frames[i].patch[3], 255, 'opaque magenta must not disappear');
        assert.deepEqual(Array.from(frames[i].patch.slice(0,4)), Array.from(frames[0].patch.slice(0,4)));
        assert.deepEqual(Array.from(frames[i].patch.slice(8,12)), Array.from(frames[0].patch.slice(8,12)));
    }
}
assert(frames[2].patch.every((v, i) => i % 4 !== 3 || v === 0));
assert.equal(frames[1].patch[10 * 4 + 3], 0);
assert.equal(frames[3].patch[10 * 4 + 3], 255);
assert(gif.frames.filter(f => f.image).slice(1).every(f => !f.image.lct), 'frames must use the shared palette');
// Large encoded frames must concatenate correctly across the worker page boundary.
let seed = 12345;
const noise = new Uint8ClampedArray(192 * 192 * 4);
for (let p = 0; p < noise.length; p++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[p] = p % 4 === 3 ? 255 : seed >>> 24;
}
const big = await encode({index:0, last:true, width:192, height:192, globalPalette:palette, data:noise});
assert(big.data.length > 1, 'test must cover multiple worker pages');
const bigDecoded = await decode([helpers.encodedFrameBlob(big)]);
assert.equal(bigDecoded.frames[0].patch.length, 192 * 192 * 4);
assert(bigDecoded.frames[0].patch.every((v, i) => i % 4 !== 3 || v === 255));
// Refreshing an unchanged preview size must not clear its backing canvas.
let resets = 0, previewWidth = 64, previewHeight = 64;
const previewCanvas = {
    get width() { return previewWidth; }, set width(v) { resets++; previewWidth = v; },
    get height() { return previewHeight; }, set height(v) { resets++; previewHeight = v; }
};
const preview = vm.createContext({source:{width:64,height:64}, qualityWidth:480, cropRect:null, cropEditing:false, canvas:previewCanvas,
    $: () => ({textContent:''}), lastPreviewFrame:0, lastVideoPreview:0});
vm.runInContext(scripts[2].slice(scripts[2].indexOf('function sourceRegion()'), scripts[2].indexOf('function updateCropOverlay()')), preview);
preview.refreshPreviewSize();
assert.equal(resets, 0, 'unchanged size must not blank the preview');
preview.qualityWidth = 32;
preview.refreshPreviewSize();
assert.equal(previewCanvas.width, 32);
assert.equal(previewCanvas.height, 32);
// Cropping uses source pixels, preserves aspect ratio and never enlarges the selection.
preview.source = {width: 960, height: 640};
preview.cropRect = {x: 123, y: 81, width: 400, height: 200};
preview.qualityWidth = 480;
assert.deepEqual({...preview.outputSize()}, {width:400,height:200});
preview.qualityWidth = 320;
assert.deepEqual({...preview.outputSize()}, {width:320,height:160});
let drawn;
preview.drawRegion({drawImage(...args) { drawn = args; }}, 'frame', 320, 160);
assert.deepEqual(drawn, ['frame',123,81,400,200,0,0,320,160]);
preview.cropEditing = true;
preview.refreshPreviewSize();
assert.equal(previewCanvas.width,320);
assert.equal(previewCanvas.height,213, 'selection editor shows the entire source');
preview.cropEditing = false;
preview.refreshPreviewSize();
assert.equal(previewCanvas.height,160, 'finished preview has export proportions');
preview.cropRect = null;
assert.deepEqual({...preview.outputSize()}, {width:320,height:213});
// Pointer drags must stay within the source, including one-pixel selections.
const cropElements = new Map();
const cropElement = id => {
    if (!cropElements.has(id)) cropElements.set(id, {setPointerCapture() {}});
    return cropElements.get(id);
};
const crop = vm.createContext({$:cropElement, source:{width:960,height:640}, cropRect:{x:123,y:81,width:400,height:200}, cropEditing:true, cropDrag:null, cropAspect:'free', busy:false, recordAction() {}});
vm.runInContext(scripts[2].slice(scripts[2].indexOf('function updateCropOverlay()'),scripts[2].indexOf('function scheduleQualityPreview()')),crop);
crop.cropPoint = event => ({x:event.x,y:event.y});
crop.cropChanged = () => {};
const pointer = (x,y,edge) => ({x,y,pointerId:1,button:0,preventDefault() {}, target:{dataset:{edge},closest:()=>true}});
cropElement('cropOverlay').onpointerdown(pointer(123,81));
cropElement('cropOverlay').onpointermove(pointer(960,640));
assert.deepEqual({...crop.cropRect}, {x:560,y:440,width:400,height:200});
cropElement('cropOverlay').onpointerup(pointer(960,640));
cropElement('cropOverlay').onpointerdown(pointer(560,440,'nw'));
cropElement('cropOverlay').onpointermove(pointer(960,640));
assert.deepEqual({...crop.cropRect}, {x:959,y:639,width:1,height:1});
cropElement('cropOverlay').onpointercancel(pointer(960,640));
assert.equal(crop.cropDrag,null);
// A 16:9 preset fills a landscape source, centres inside a portrait source,
// and keeps the opposite edge anchored for all eight resize handles.
assert.deepEqual({...crop.fixedAspectRect({width:1920,height:1080},{x:960,y:540},.5,.5,1920,'16:9')}, {x:0,y:0,width:1920,height:1080});
assert.deepEqual({...crop.fixedAspectRect({width:1080,height:1920},{x:540,y:960},.5,.5,1080,'16:9')}, {x:4,y:659,width:1072,height:603});
const startRect = {x:160,y:180,width:640,height:360};
for (const edge of ['nw','n','ne','e','se','s','sw','w']) {
    for (const point of [{x:0,y:0},{x:960,y:640},{x:450,y:350}]) {
        const r = crop.resizeFixedCrop(startRect,edge,point,{width:960,height:640},'16:9');
        assert.equal(r.width*9,r.height*16, `ratio must survive ${edge} resize`);
        assert(r.x>=0 && r.y>=0 && r.x+r.width<=960 && r.y+r.height<=640);
        if (edge.includes('w')) assert.equal(r.x+r.width,startRect.x+startRect.width);
        if (edge.includes('e')) assert.equal(r.x,startRect.x);
        if (edge.includes('n')) assert.equal(r.y+r.height,startRect.y+startRect.height);
        if (edge.includes('s')) assert.equal(r.y,startRect.y);
    }
}
crop.cropRect = {...startRect}; crop.cropAspect = '16:9';
cropElement('cropOverlay').onpointerdown(pointer(800,540,'se'));
cropElement('cropOverlay').onpointermove(pointer(900,600));
assert.equal(crop.cropRect.width*9,crop.cropRect.height*16,'pointer handler preserves the selected ratio');
cropElement('cropOverlay').onpointerup(pointer(900,600));
assert(scripts[2].includes('drawRegion(oc, raw, width, height)'), 'GIF export uses selection');
assert(scripts[2].includes('drawRegion(oc, exportVideo, width, height)'), 'video export uses selection');
// Background processing must preserve original alpha and opaque magenta until encoding.
const background = vm.createContext({backgroundColor:null, $:id => ({checked:false,value:'0'})});
vm.runInContext(scripts[2].slice(scripts[2].indexOf('function removeBackground('), scripts[2].indexOf('function frameAt(')), background);
const rgba = new Uint8ClampedArray([255,0,255,255, 255,0,255,0]);
background.removeBackground({data:rgba,width:2,height:1});
assert.deepEqual(Array.from(rgba), [255,0,255,255, 255,0,255,0]);
// Failed workers must release their listeners and report an error instead of hanging.
const badWorker = {...worker, postMessage() { queueMicrotask(() => events.emit('error', new Error('test'))); }};
await assert.rejects(helpers.encodeFrame(badWorker, {data:new Uint8ClampedArray(4)}), /Не удалось обработать/);
assert.equal(events.listenerCount('message'), 0);
console.log('Passed: script syntax, HTML/TXT sync, exact video FPS and total duration, shared palette, stable colours, opaque magenta, exact alpha, empty transparent frame, disposal, timing, buffer transfer, multi-page GIF, preview canvas preservation, crop bounds and 16:9 presets/resizing, background alpha preservation, worker error cleanup.');
