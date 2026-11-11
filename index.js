// Aishiteru Theme: one-click theme installer for SillyTavern.
// Uses SillyTavern's own UI flows (theme import, background upload) so ST state stays consistent.

const MODULE = 'aishiteru_theme';
const TAG = 'Aishiteru Theme';
const THEME_FAMILY = 'Aishiteru Theme';
/** UI language: Russian when SillyTavern or the browser is set to Russian, English otherwise. */
const RU = String(localStorage.getItem('language') || navigator.language || '').toLowerCase().startsWith('ru');
const T = (ru, en) => (RU ? ru : en);
// A new theme version needs a new name: ST's importer skips names that already exist.
const THEME_NAME = 'Aishiteru Theme';
const BG_DESKTOP = 'aishiteru_bg_desktop.webp';
const BG_MOBILE = 'aishiteru_bg_mobile.webp';
const BASE = new URL('.', import.meta.url).href;

const ctx = () => SillyTavern.getContext();
const $ = window.jQuery;

const ACTIVE_CLASS = 'ds-theme-active';
const CSS_MARKER = '/* Aishiteru Theme';
// Keep these in sync with ds-art-frames and ds-rewind-hand (500ms).
const MOTION_DURATION_MS = 500;
const MOTION_FALLBACK_MS = MOTION_DURATION_MS + 350;
/** The sprite plays in .ds-fx corner windows (children); the message itself owns the other animations. */
const ownsMotion = (message, target) => target === message || (target instanceof Element && target.closest('.ds-fx')?.parentElement === message);
function clearMotionAfter(message, className, names) {
    const clear = event => {
        if (event && (!ownsMotion(message, event.target) || !names.includes(event.animationName))) return;
        message.classList.remove(className);
        message.removeEventListener('animationend', clear);
        clearTimeout(fallback);
    };
    message.addEventListener('animationend', clear);
    const fallback = setTimeout(clear, MOTION_FALLBACK_MS);
}
const FX_SPRITES = ['send-tl', 'send-br', 'swipe-tl', 'swipe-br'].map(n => `${BASE}assets/motion/ds-${n}-sprite.webp`);
const fxCache = [];
/** Decode the strips once, before the first send/swipe: a cold decode on a phone stalls the first play. */
function preloadFx() {
    for (const src of FX_SPRITES) {
        const img = new Image();
        img.src = src;
        img.decode?.().catch(() => {});
        fxCache.push(img);
    }
}
const motionOff = () => document.body.classList.contains('reduced-motion')
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    || window.matchMedia?.('(forced-colors: active)').matches;
/** Two small corner windows that play the frame strips (see motion.css for why they stay unlayered). */
function playFx(message, kind) {
    if (!message || motionOff()) return;
    message.querySelectorAll(':scope > .ds-fx').forEach(el => el.remove());
    const boxes = ['tl', 'br'].map(corner => {
        const box = document.createElement('div');
        box.className = `ds-fx ds-fx-${kind} ds-fx-${corner}`;
        box.setAttribute('aria-hidden', 'true');
        return box;
    });
    message.append(...boxes);
    const done = () => boxes.forEach(el => el.remove());
    // Remove after the event has bubbled to the message (its cleanup checks that the target is ours).
    boxes[0].addEventListener('animationend', e => { if (e.animationName === 'ds-art-frames') setTimeout(done, 0); });
    setTimeout(done, MOTION_FALLBACK_MS);
}
globalThis.AishiteruTheme = Object.assign(globalThis.AishiteruTheme ?? {}, { playFx });
function isAishiteruActive() {
    const css = document.getElementById('custom-style')?.textContent ?? '';
    if (css.includes(CSS_MARKER)) return true;
    return String(ctx().powerUserSettings?.theme ?? $('#themes').val() ?? '').startsWith(THEME_FAMILY);
}
let themeSyncQueued = false;
function syncThemeClass() {
    if (themeSyncQueued) return;
    themeSyncQueued = true;
    requestAnimationFrame(() => {
        themeSyncQueued = false;
        const active = isAishiteruActive();
        document.body.classList.toggle(ACTIVE_CLASS, active);
        document.body.classList.toggle('ds-blur-active', active && Number(ctx().powerUserSettings?.blur_strength) > 0);
    });
}
function watchTheme() {
    new MutationObserver(syncThemeClass).observe(document.head, { childList: true, subtree: true, characterData: true });
    $(document).on('change', '#themes', syncThemeClass);
    $(document).on('input change', '#blur_strength', syncThemeClass);
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.SETTINGS_UPDATED, syncThemeClass);
    eventSource.on(eventTypes.APP_READY, syncThemeClass);
    // A render event marks a new entry once; deleting a message cannot reanimate its predecessor.
    const markNew = (id, type) => {
        if (!isAishiteruActive() || type === 'swipe' || type === 'append') return;
        const message = document.querySelector(`#chat .mes[mesid="${Number(id)}"]`);
        if (!message) return;
        message.classList.add('ds-new');
        const isUser = message.getAttribute('is_user') === 'true';
        if (isUser) playFx(message, 'send');
        clearMotionAfter(message, 'ds-new', isUser ? ['ds-art-frames'] : ['ds-mes-in', 'ds-fade-in']);
    };
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, markNew);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, markNew);
    // ST removes .slide after each 125ms half-swipe, which would cancel a 500ms turn.
    // MESSAGE_SWIPED fires between the halves; keep one independent, complete turn.
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => {
        if (!isAishiteruActive()) return;
        const message = document.querySelector(`#chat .mes[mesid="${Number(id)}"]`);
        if (!message || message.classList.contains('ds-rewinding')) return;
        message.classList.add('ds-rewinding');
        playFx(message, 'swipe');
        // The sprite owns cleanup. An unrelated child or dial animation cannot cut it short.
        // The fallback also clears reduced-motion / forced-color states with no animationend.
        clearMotionAfter(message, 'ds-rewinding', ['ds-art-frames']);
    });
    syncThemeClass();
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= { prevTheme: null, prevBg: null, prevFitting: null, installed: null };
    return all[MODULE];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Save ST settings right away: the debounced save is lost if the user presses F5 right after "Done". */
async function saveSettingsNow() {
    try {
        const { saveSettings } = await import(new URL('../../../../script.js', BASE).href);
        await saveSettings();
    } catch (err) {
        console.warn(`[${TAG}] immediate save failed, falling back to the debounced one`, err);
        ctx().saveSettingsDebounced();
        await sleep(1500);
    }
}

/** Short content hash, used to tell CSS this extension shipped from a user's own edits. */
const cssHash = (text) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return `${text.length}:${(h >>> 0).toString(36)}`;
};
const bundledCss = async () => {
    const res = await fetch(`${BASE}theme/Aishiteru-Theme.css`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`theme CSS ${res.status}`);
    return res.text();
};

/**
 * ST keeps its own copy of a theme's CSS, and the importer skips a name that already exists,
 * so an extension update would never reach an installed theme. While our theme is selected,
 * replace its CSS with the bundled one and save the theme, unless the user edited it.
 */
let cssSyncBusy = false;
/** Hashes of every theme CSS this extension has shipped/applied on this profile (newest last). */
const knownCss = (s) => {
    s.cssHashes ??= s.cssHash ? [s.cssHash] : [];
    return s.cssHashes;
};
const rememberCss = (s, hash) => {
    const list = knownCss(s);
    if (!list.includes(hash)) list.push(hash);
    if (list.length > 20) list.splice(0, list.length - 20);
    s.cssHash = hash;
};

/**
 * Write only custom_css into the installed theme file. ST's "update theme" button would snapshot every
 * current UI setting (chat width, font scale, timestamps, reduced motion...) into the theme as well.
 */
async function saveThemeCssOnly(css) {
    const headers = ctx().getRequestHeaders();
    const res = await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' });
    if (!res.ok) throw new Error(`settings/get ${res.status}`);
    const theme = (await res.json())?.themes?.find(t => t?.name === THEME_NAME);
    if (!theme) throw new Error('installed theme not found');
    const save = await fetch('/api/themes/save', { method: 'POST', headers, body: JSON.stringify({ ...theme, custom_css: css }) });
    if (!save.ok) throw new Error(`themes/save ${save.status}`);
}

async function syncInstalledCss() {
    if (busy || cssSyncBusy) return;
    if (String(ctx().powerUserSettings?.theme ?? '') !== THEME_NAME) return;
    cssSyncBusy = true;
    try {
        const s = settings();
        const bundled = await bundledCss();
        const current = String(ctx().powerUserSettings?.custom_css ?? '');
        if (current === bundled) {
            if (s.cssHash !== cssHash(bundled)) { rememberCss(s, cssHash(bundled)); ctx().saveSettingsDebounced(); }
            return;
        }
        // Ours = a version this extension shipped (ST may still hold an older one in memory this session),
        // or, with no record yet, CSS that carries our header. Anything else is the user's own edit.
        const ours = knownCss(s).length ? knownCss(s).includes(cssHash(current)) : current.startsWith(CSS_MARKER);
        if (!ours) {
            console.info(`[${TAG}] Theme CSS was edited by the user; not updating it automatically.`);
            return;
        }
        await saveThemeCssOnly(bundled);
        $('#customCSS').val(bundled).trigger('input'); // live CSS + the user's settings (custom_css only)
        rememberCss(s, cssHash(bundled));
        ctx().saveSettingsDebounced();
        toastr.info(T('Тема обновлена до новой версии.', 'The theme was updated to the new version.'), TAG);
    } catch (err) {
        console.warn(`[${TAG}] theme CSS sync failed`, err);
    } finally {
        cssSyncBusy = false;
    }
}

async function waitFor(check, timeoutMs, stepMs = 150) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (check()) return true;
        await sleep(stepMs);
    }
    return check();
}

async function bundledFile(rel, name, type) {
    const res = await fetch(BASE + rel, { cache: 'no-cache' });
    if (!res.ok) throw new Error(T(`Не найден файл расширения: ${rel} (${res.status})`, `Extension file not found: ${rel} (${res.status})`));
    return new File([await res.blob()], name, { type });
}

/** Feeds a File into one of ST's hidden <input type=file> elements, as if the user picked it. */
function feedFileInput(selector, file) {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLInputElement)) throw new Error(T(`Не найден элемент ${selector}: эта версия SillyTavern не поддерживается`, `Element ${selector} not found: this SillyTavern version is not supported`));
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** True once ST's change handler has finished: both ST handlers clear input.value at the end. */
const inputDrained = (selector) => {
    const input = document.querySelector(selector);
    return !(input instanceof HTMLInputElement) || !input.files || input.files.length === 0;
};

const themeOption = (name) => Array.from(document.querySelectorAll('#themes option')).find(o => o.value === name);
const isChatBgLocked = () => !!ctx().chatMetadata?.custom_background;
/** Inline style only: the theme's mobile CSS overrides the computed background-image with !important. */
const bg1Inline = () => String(document.getElementById('bg1')?.style.backgroundImage ?? '');

/** Global background file name (background_settings.name). `/bg` without args returns it; DOM is a fallback. */
async function currentBgFile() {
    try {
        const res = await ctx().executeSlashCommandsWithOptions('/bg', { handleParserErrors: false, handleExecutionErrors: false });
        const name = String(res?.pipe ?? '').trim();
        if (name) return name;
    } catch (err) {
        console.debug(`[${TAG}] /bg failed, falling back to DOM`, err);
    }
    return $('.bg_example.selected-background').first().attr('bgfile') || null;
}

function setStatus(text) {
    $('#dst_status').text(text);
}

function setBusy(busy) {
    $('#dst_install, #dst_revert').attr('disabled', busy ? 'disabled' : null);
}

async function uploadBackgroundSilently(file) {
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders({ omitContentType: true }),
        body: fd,
        cache: 'no-cache',
    });
    if (!res.ok) throw new Error(T(`Не удалось загрузить ${file.name} (${res.status})`, `Could not upload ${file.name} (${res.status})`));
}

/** Fingerprint of the bundled backgrounds: changes whenever a release ships new artwork. */
async function bundledBgKey() {
    const size = async (rel) => {
        const res = await fetch(BASE + rel, { method: 'HEAD', cache: 'no-cache' });
        return res.ok ? res.headers.get('content-length') ?? '?' : '?';
    };
    return `${await size(`assets/${BG_DESKTOP}`)}:${await size(`assets/${BG_MOBILE}`)}`;
}

/**
 * The installer uploads the backgrounds to ST's server once, so new artwork in an extension update
 * would never replace them. After an update, re-upload both files under the same names (ST's
 * endpoint overwrites them), only for users who installed the theme.
 */
let bgSyncBusy = false;
async function syncInstalledBackgrounds() {
    const s = settings();
    if (busy || bgSyncBusy || !s.installed) return;
    bgSyncBusy = true;
    try {
        const key = await bundledBgKey();
        if (key.includes('?') || s.bgKey === key) return;
        await uploadBackgroundSilently(await bundledFile(`assets/${BG_MOBILE}`, BG_MOBILE, 'image/webp'));
        await uploadBackgroundSilently(await bundledFile(`assets/${BG_DESKTOP}`, BG_DESKTOP, 'image/webp'));
        const hadKey = !!s.bgKey;
        s.bgKey = key;
        ctx().saveSettingsDebounced();
        if (hadKey || s.cssHash) toastr.info(T('Фон темы обновлён. Нажми F5, если видишь старый.', 'The theme background was updated. Press F5 if you still see the old one.'), TAG);
    } catch (err) {
        console.warn(`[${TAG}] background sync failed`, err);
    } finally {
        bgSyncBusy = false;
    }
}

let busy = false;

async function install() {
    if (busy) return;
    busy = true;
    const s = settings();
    setBusy(true);
    const log = [];
    const step = (t) => { log.push(t); setStatus(log.join('\n')); };

    try {
        // Remember what to roll back to (only if the user is not already on our theme).
        const curTheme = String($('#themes').val() ?? '');
        if (curTheme && !curTheme.startsWith(THEME_FAMILY)) s.prevTheme = curTheme;
        const curBg = await currentBgFile();
        if (curBg && curBg !== BG_DESKTOP) {
            s.prevBg = curBg;
            s.prevFitting = String($('#background_fitting').val() ?? '') || null;
        }
        ctx().saveSettingsDebounced();

        // 1. Mobile background: just put the file on the server (the theme CSS points at it on phones).
        step(T('1/4 Загружаю фон для телефона…', '1/4 Uploading the phone background…'));
        await uploadBackgroundSilently(await bundledFile(`assets/${BG_MOBILE}`, BG_MOBILE, 'image/webp'));

        // 2. Desktop background through ST's own uploader: it saves, selects and refreshes the list.
        step(T('2/4 Загружаю и выбираю фон для ПК…', '2/4 Uploading and selecting the PC background…'));
        const desktopFile = await bundledFile(`assets/${BG_DESKTOP}`, BG_DESKTOP, 'image/webp');
        const tabs = $('#bg_tabs');
        const hasTabs = tabs.length && tabs.data('ui-tabs');
        const prevTab = hasTabs ? tabs.tabs('option', 'active') : null;
        if (hasTabs) tabs.tabs('option', 'active', 0); // global, not chat-only
        try {
            feedFileInput('#add_bg_button', desktopFile);
            const done = await waitFor(() => inputDrained('#add_bg_button'), 60000);
            if (!done) throw new Error(T('Загрузчик фонов SillyTavern не ответил за 60 с.', 'SillyTavern\'s background uploader did not answer in 60 s.'));
        } finally {
            if (hasTabs && prevTab !== null && prevTab !== 0) tabs.tabs('option', 'active', prevTab);
        }
        if (!$(`.bg_example[bgfile="${BG_DESKTOP}"]`).length && (await currentBgFile()) !== BG_DESKTOP) {
            throw new Error(T('Фон для ПК не загрузился (см. консоль браузера).', 'The PC background did not upload (see the browser console).'));
        }
        $('#background_fitting').val('cover').trigger('input');
        if (isChatBgLocked()) {
            step(T('   ⚠ Фон установлен для всех чатов, но у этого чата закреплён свой фон, он показывается вместо нашего.', '   ⚠ The background is set for all chats, but this chat has its own locked background, which is shown instead.'));
        } else if (!bg1Inline().includes(BG_DESKTOP)) {
            step(T(`   ⚠ Фон загружен, но не применился: выбери ${BG_DESKTOP} в меню Backgrounds.`, `   ⚠ The background uploaded but was not applied: pick ${BG_DESKTOP} in the Backgrounds menu.`));
        }

        // 3. Theme: import through ST's importer (it shows a confirmation about Google Fonts @import).
        if (!themeOption(THEME_NAME)) {
            step(T('3/4 Импортирую тему… Подтверди окно про @import (это шрифты Google).', '3/4 Importing the theme… Confirm the @import window (those are Google Fonts).'));
            feedFileInput('#ui_preset_import_file', await bundledFile('theme/Aishiteru-Theme.json', 'Aishiteru-Theme.json', 'application/json'));
            // ST's handler clears the input in `finally`, whether the user confirmed, cancelled or it failed.
            await waitFor(() => inputDrained('#ui_preset_import_file'), 10 * 60 * 1000, 250);
            if (!themeOption(THEME_NAME)) throw new Error(T('Тема не импортирована (окно подтверждения отменено или ошибка импорта).', 'The theme was not imported (the confirmation was cancelled or the import failed).'));
        } else {
            step(T('3/4 Тема уже установлена, пропускаю импорт.', '3/4 The theme is already installed, skipping the import.'));
        }

        // 4. Apply.
        step(T(`4/4 Включаю «${THEME_NAME}»…`, `4/4 Applying "${THEME_NAME}"…`));
        $('#themes').val(THEME_NAME).trigger('change');

        s.installed = THEME_NAME;
        try { rememberCss(s, cssHash(await bundledCss())); } catch { /* sync will record it later */ }
        try { s.bgKey = await bundledBgKey(); } catch { /* sync will record it later */ }
        await saveSettingsNow();
        step(T('Готово ✔ Нажми F5, чтобы подгрузились шрифты.', 'Done ✔ Press F5 to load the fonts.'));
        toastr.success(T('Тема установлена. Нажми F5 для загрузки шрифтов.', 'Theme installed. Press F5 to load the fonts.'), TAG);
    } catch (err) {
        console.error(`[${TAG}]`, err);
        step('✖ ' + (err?.message || err));
        toastr.error(String(err?.message || err), T(`${TAG}: установка не завершена`, `${TAG}: installation not finished`));
    } finally {
        busy = false;
        setBusy(false);
    }
}

async function revert() {
    if (busy) return;
    busy = true;
    const s = settings();
    setBusy(true);
    try {
        if (s.prevTheme && themeOption(s.prevTheme)) {
            $('#themes').val(s.prevTheme).trigger('change');
        } else {
            toastr.warning(T('Прежняя тема неизвестна: выбери её вручную в User Settings → UI Theme.', 'The previous theme is unknown: pick it in User Settings → UI Theme.'), TAG);
        }
        if (s.prevBg) {
            const el = $('#bg_menu_content .bg_example').filter((_, x) => x.getAttribute('bgfile') === s.prevBg).first();
            // shiftKey: ST's own "bypass chat lock" path, so the global background is restored, not the chat's locked one.
            if (el.length) {
                el.trigger($.Event('click', { shiftKey: true }));
                if (s.prevFitting) $('#background_fitting').val(s.prevFitting).trigger('input');
            }
            else toastr.info(T(`Фон «${s.prevBg}» не найден в списке: выбери его в меню Backgrounds.`, `Background "${s.prevBg}" is not in the list: pick it in the Backgrounds menu.`), TAG);
        }
        await saveSettingsNow();
        setStatus(T(`Возвращено: тема «${s.prevTheme ?? '?'}», фон «${s.prevBg ?? '?'}».\nФайлы темы и фонов не удалены, их можно удалить обычным способом.`, `Restored: theme "${s.prevTheme ?? '?'}", background "${s.prevBg ?? '?'}".\nThe theme and background files were not deleted; remove them the usual way if you like.`));
    } finally {
        busy = false;
        setBusy(false);
    }
}

function renderPanel() {
    const html = `
    <div id="dst_settings" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Aishiteru Theme</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="dst-hint">${T(`Загрузит фоны, импортирует и включит тему «${THEME_NAME}». Прежние тема и фон запоминаются, их можно вернуть.`, `Uploads the backgrounds, imports and applies "${THEME_NAME}". Your previous theme and background are remembered so you can go back.`)}</div>
            <div class="dst-row">
                <div id="dst_install" class="menu_button menu_button_icon"><i class="fa-solid fa-palette"></i><span>${T('Установить тему', 'Install theme')}</span></div>
                <div id="dst_revert" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate-left"></i><span>${T('Вернуть прежнюю', 'Restore previous')}</span></div>
            </div>
            <div id="dst_status" class="dst-status"></div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#dst_install').on('click', install);
    $('#dst_revert').on('click', revert);

    const s = settings();
    if (themeOption(THEME_NAME)) {
        setStatus(String($('#themes').val()) === THEME_NAME ? T(`Тема «${THEME_NAME}» включена.`, `"${THEME_NAME}" is active.`) : T(`Тема «${THEME_NAME}» установлена, но сейчас выбрана другая.`, `"${THEME_NAME}" is installed, but another theme is selected.`));
    } else if (s.installed) {
        setStatus(T('Тема была удалена, можно установить заново.', 'The theme was removed, you can install it again.'));
    }
}

/**
 * Runs once per theme version: on the very first start, or when an older Aishiteru theme is the active one
 * (so updates reach users). Never re-applies after the user switched to another theme or reverted.
 */
function autoInstallOnce() {
    const s = settings();
    if (themeOption(THEME_NAME) || s.autoTried === THEME_NAME) return;
    const cur = String($('#themes').val() ?? '');
    const onOlderOurs = cur.startsWith(THEME_FAMILY) && cur !== THEME_NAME;
    const firstRun = !s.installed && !s.autoTried;
    if (!firstRun && !onOlderOurs) return;
    s.autoTried = THEME_NAME;
    ctx().saveSettingsDebounced();
    toastr.info(onOlderOurs ? T('Обновляю тему до новой версии…', 'Updating the theme to the new version…') : T('Ставлю тему автоматически…', 'Installing the theme…'), TAG);
    install();
}

jQuery(() => {
    watchTheme();
    try {
        renderPanel();
    } catch (err) {
        console.error(`[${TAG}] panel init failed`, err);
    }
    // APP_READY auto-fires for late subscribers, so this runs once the UI (backgrounds, themes) is loaded.
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.APP_READY, () => setTimeout(() => { autoInstallOnce(); syncInstalledCss(); syncInstalledBackgrounds(); preloadFx(); }, 500));
    $(document).on('change', '#themes', () => setTimeout(syncInstalledCss, 300));
});
