import {
    eventSource,
    event_types,
    saveSettings as stSaveSettings,
    getThumbnailUrl,
    setUserName,
    default_user_avatar,
} from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import {
    getUserAvatars,
    getUserAvatar,
    setUserAvatar,
    setPersonaDescription,
    user_avatar,
    isPersonaLocked,
    togglePersonaLock,
    convertCharacterToPersona,
} from '../../../personas.js';
import { world_names, openWorldInfoEditor } from '../../../world-info.js';
import { isFirefox } from '../../../browser-fixes.js';

const MODULE_SETTINGS_KEY = 'aevPersonaManager';

const DEFAULT_SETTINGS = {
    hijackDrawer: true,
    cropOnUpload: true,
    sort: 'az',
    gridColumns: '6',
    aspectRatio: '4 / 5',
    pageSize: 30,
    folders: [],
    assignments: {},
    favorites: [],
    notes: {},
    lastUsed: {},
    firstSeen: {},     // fallback timestamp source for sort
    theme: 'native',
};

/** Resolve the extension folder name from the module URL. */
const EXTENSION_NAME = (() => {
    const m = String(import.meta.url).match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
    return m ? m[1] : 'third-party/persona-manager';
})();

function getContext() {
    return SillyTavern.getContext();
}

// ── Module state ──────────────────────────────────────────────────────────
const FOLDER_ALL = '__all__';
const FOLDER_UNFILED = '__unfiled__';

// Persona description positions + defaults, mirroring personas.js.
const POS = { IN_PROMPT: 0, AT_DEPTH: 4 };
const DEFAULT_DEPTH = 2;
const DEFAULT_ROLE = 0;

const PAGE_SIZES = Object.freeze([10, 30, 60, 100]);
const GRID_COLUMNS = Object.freeze(['auto', '3', '4', '5', '6', '7', '8', '9', '10']);
const ASPECT_RATIOS = Object.freeze(['1 / 1', '3 / 4', '4 / 5', '5 / 4', '4 / 3']);
const SORT_MODES = Object.freeze(['az', 'za', 'newest', 'oldest', 'recent']);
const FILTER_MODES = Object.freeze(['all', 'active', 'default', 'locked', 'favorites']);
const CROP_PREVIEW_DIM = 1280;
const AVATAR_EXPORT_DIM = 1024;
const CROP_PRESETS = Object.freeze([
    { id: 'free', ratio: NaN, labelKey: 'crop.free' },
    { id: '1 / 1', ratio: 1, label: '1:1' },
    { id: '2 / 3', ratio: 2 / 3, label: '2:3' },
    { id: '3 / 4', ratio: 3 / 4, label: '3:4' },
    { id: '4 / 5', ratio: 4 / 5, label: '4:5' },
    { id: '5 / 4', ratio: 5 / 4, label: '5:4' },
    { id: '4 / 3', ratio: 4 / 3, label: '4:3' },
]);
const MOBILE_LAYOUT_QUERY = '(max-width: 900px)';
const MOBILE_LAYOUT_MEDIA = window.matchMedia(MOBILE_LAYOUT_QUERY);
const EDITOR_UPDATE = Symbol('persona-manager-edit');
const TAG = 'PM';
const warn = (step, err) => console.warn(`[${TAG}] ${step}`, err);

function isMobileLayout() {
    return MOBILE_LAYOUT_MEDIA.matches;
}

// Override themes. "native" carries no [data-theme] attribute (keeps the
// SmartTheme-derived defaults); the rest override the --pm-* tokens in CSS.
// Swatch preview colors: [background, foreground, accent].
const THEME_SWATCHES = Object.freeze({
    native: ['var(--SmartThemeBlurTintColor, #1e1e24)', 'var(--SmartThemeBodyColor, #e6e6e6)', 'var(--SmartThemeQuoteColor, #6aa9ff)'],
    'github-dark': ['#0d1117', '#c9d1d9', '#58a6ff'],
    light: ['#ffffff', '#1f2328', '#0969da'],
    dracula: ['#282a36', '#f8f8f2', '#bd93f9'],
    'solarized-dark': ['#002b36', '#93a1a1', '#268bd2'],
    nord: ['#2e3440', '#e5e9f0', '#88c0d0'],
});
const THEMES = Object.freeze(Object.keys(THEME_SWATCHES));
// Maps theme id → i18n key for its display name.
const THEME_LABEL_KEYS = Object.freeze({
    native: 'theme.native',
    'github-dark': 'theme.githubDark',
    light: 'theme.light',
    dracula: 'theme.dracula',
    'solarized-dark': 'theme.solarizedDark',
    nord: 'theme.nord',
});

const state = {
    isOpen: false,
    openGeneration: 0,
    domPromise: null,
    suppressDrawerHijack: false,
    dom: {},
    avatars: null,          // cached list of avatar ids from getUserAvatars(false)
    avatarLoadGeneration: 0,
    search: '',
    sort: 'az',
    activeFilter: 'all',
    pageSize: 30,
    currentPage: 1,
    activeFolderId: FOLDER_ALL,
    sidebarPreference: null, // desktop session override for folder sidebar visibility
    dragId: null,           // avatar id being dragged
    selectMode: false,
    selected: new Set(),    // avatar ids selected for bulk actions
    editorId: null,         // avatar id currently open in the editor panel
    editorMaximized: false, // editor expanded to the full viewport
    editorCommitted: null,
    editorOpener: null,
    commitEditorEdits: null,
    savePending: false,
    saveTimer: null,
    saveStatus: '',
    searchTimer: null,
    busy: false,            // backup/restore in progress
    suppressPersonaReload: false,
    imageRevisions: new Map(), // cache keys only for avatars changed this session
    lastFocusedElement: null,
    overlayOpener: null,
};

const FALLBACK_AVATAR_URL = '/img/ai4.png';

// Probe once whether ST serves persona thumbnails (some setups/platforms don't
// generate them, which 404s on mobile). If not, fall back to the full avatar.
let _supportsPersonaThumbnails = null;
function supportsPersonaThumbnails() {
    if (_supportsPersonaThumbnails === null) {
        try {
            _supportsPersonaThumbnails = String(getThumbnailUrl('persona', 'probe.png', true)).includes('&t=');
        } catch (_) {
            _supportsPersonaThumbnails = false;
        }
    }
    return _supportsPersonaThumbnails;
}

/** Resolve an image URL for a persona avatar id, robust across platforms. */
function personaImageUrl(avatarId) {
    if (!avatarId) return FALLBACK_AVATAR_URL;
    try {
        if (supportsPersonaThumbnails()) {
            const url = getThumbnailUrl('persona', avatarId, isFirefox());
            if (typeof url === 'string' && url) return withImageRevision(url, avatarId);
        }
        // getUserAvatar() => "User Avatars/<file>"; encode each path segment so
        // the space in the directory name doesn't break the request.
        const path = getUserAvatar(avatarId).split('/').map(encodeURIComponent).join('/');
        return withImageRevision(`/${path}`, avatarId);
    } catch (_) {
        return FALLBACK_AVATAR_URL;
    }
}

function withImageRevision(url, avatarId) {
    const revision = state.imageRevisions.get(avatarId);
    if (!revision) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}pmv=${revision}`;
}

/** Persona metadata view-model for an avatar id. */
function personaMeta(avatarId) {
    const name = power_user.personas?.[avatarId] || t('persona.unnamed');
    const desc = power_user.persona_descriptions?.[avatarId];
    return {
        id: avatarId,
        name,
        title: desc?.title || '',
        description: desc?.description || '',
        isDefault: power_user.default_persona === avatarId,
        isCurrent: avatarId === user_avatar,
    };
}

// ── i18n (EN / RU) ────────────────────────────────────────────────────────
const I18N = {
    en: {
        'app.title': 'Persona Manager',
        'persona.unnamed': '[Unnamed Persona]',
        'action.close': 'Close',
        'action.more': 'More actions',
        'toolbar.search': 'Search...',
        'toolbar.searchLabel': 'Search personas',
        'toolbar.sort': 'Sort personas',
        'sort.az': 'Name A-Z',
        'sort.za': 'Name Z-A',
        'sort.newest': 'Newest first',
        'sort.oldest': 'Oldest first',
        'sort.recent': 'Recently used',
        'filter.heading': 'Quick filters',
        'filter.all': 'All',
        'filter.active': 'Active',
        'filter.default': 'Default',
        'filter.locked': 'Locked',
        'filter.favorites': 'Favorites',
        'pager.prev': 'Previous page',
        'pager.next': 'Next page',
        'pager.range': '{from}–{to} of {total}',
        'status.empty': 'No personas match this view yet.',
        'spotlight.heading': 'Current persona',
        'spotlight.edit': 'Edit current persona: {name}',
        'spotlight.none': 'No persona selected',
        'lock.chat': 'Chat',
        'lock.character': 'Character',
        'lock.default': 'Default',
        'action.favorite': 'Toggle favorite',
        'card.active': 'Active',
        'card.use': 'Use persona: {name}',
        'card.select': 'Select persona: {name}',
        'card.edit': 'Edit',
        'card.delete': 'Delete persona',
        'card.favoriteFor': 'Toggle favorite: {name}',
        'card.editFor': 'Edit persona: {name}',
        'card.deleteConfirm': 'Delete persona "{name}"? This cannot be undone.',
        'card.deleteError': 'Failed to delete the persona.',
        'folder.all': 'All personas',
        'folder.unfiled': 'Unsorted',
        'folder.heading': 'Folders',
        'folder.toggle': 'Toggle folders',
        'folder.new': 'New folder',
        'folder.namePrompt': 'Enter a name for the new folder:',
        'folder.rename': 'Rename folder',
        'folder.pickPrompt': 'Move to folder:',
        'folder.delete': 'Delete folder',
        'folder.deleteConfirm': 'Delete folder "{name}"? Personas inside will move to Unsorted.',
        'select.toggle': 'Select',
        'select.all': 'Select all',
        'select.cancel': 'Cancel',
        'select.move': 'Move',
        'select.favorite': 'Favorite',
        'select.export': 'Export',
        'select.delete': 'Delete',
        'select.count': '{n} selected',
        'select.deleteConfirm': 'Delete {n} persona(s)? This cannot be undone.',
        'backup.export': 'Backup personas (.zip)',
        'backup.import': 'Restore personas (.zip)',
        'backup.empty': 'No personas to back up.',
        'backup.noZip': 'ZIP library unavailable.',
        'backup.invalid': 'Invalid or unreadable backup file.',
        'backup.exported': 'Backed up {n} persona(s).',
        'backup.exportedPartial': 'Backup done, but {n} image(s) failed.',
        'backup.restored': 'Restored {n} persona(s) ({skipped} skipped).',
        'backup.restoredPartial': 'Restored {n} persona(s); {f} image(s) failed.',
        'backup.progressExport': 'Backing up personas…',
        'backup.progressZip': 'Compressing…',
        'backup.progressImport': 'Restoring personas…',
        'convert.btn': 'Character → persona',
        'convert.prompt': 'Convert which character to a persona?',
        'convert.empty': 'No characters to convert.',
        'convert.error': 'Failed to convert character to persona.',
        'create.btn': 'Create persona',
        'create.short': 'New',
        'create.namePrompt': 'Enter a name for this persona:',
        'create.nameLabel': 'Persona Title (optional, display only)',
        'create.avatarLabel': 'Avatar (optional)',
        'create.avatarDefault': 'Default image',
        'create.avatarPick': 'Choose image',
        'create.avatarReset': 'Reset image',
        'create.error': 'Failed to create persona.',
        'crop.title': 'Crop avatar',
        'crop.hint': 'Drag the frame to crop your avatar, or pick a ratio below.',
        'crop.aspectLabel': 'Crop aspect ratio',
        'crop.free': 'Free',
        'crop.cardRatio': 'Current card ratio',
        'crop.apply': 'Apply',
        'settings.intro': 'A prettier, mobile-first way to browse, organize and edit your personas.',
        'settings.open': 'Open Persona Manager',
        'settings.behaviorHeading': 'Behavior',
        'settings.hijack': 'Open manager instead of the default Persona panel',
        'settings.hijackDesc': 'Clicking the Persona Management drawer button opens this manager.',
        'settings.cropOnUpload': 'Crop avatars on upload',
        'settings.cropOnUploadDesc': 'Open the crop editor before saving a newly picked persona image.',
        'settings.displayHeading': 'Display',
        'settings.gridColumns': 'Cards per row',
        'settings.gridColumnsDesc': 'Maximum count on larger screens; fewer columns in narrow spaces. Mobile uses two columns.',
        'settings.aspectRatio': 'Image ratio',
        'settings.aspectRatioDesc': 'Avatar proportions on desktop and mobile.',
        'settings.grid.auto': 'Auto',
        'settings.pageSize': 'Personas per page',
        'settings.pageSizeDesc': 'Fewer per page keeps large libraries fast.',
        'settings.themeHeading': 'Appearance',
        'settings.theme': 'Manager theme',
        'settings.themeDesc': 'Color scheme for the manager window.',
        'theme.pick': 'Theme',
        'theme.native': 'Native',
        'theme.githubDark': 'GitHub Dark',
        'theme.light': 'Light',
        'theme.dracula': 'Dracula',
        'theme.solarizedDark': 'Solarized Dark',
        'theme.nord': 'Nord',
        'editor.back': 'Back',
        'editor.heading': 'Persona editor',
        'editor.saving': 'Pending save',
        'editor.autosave': 'Autosave',
        'editor.close': 'Close editor',
        'editor.expand': 'Full screen',
        'editor.collapse': 'Exit full screen',
        'editor.expandDesc': 'Expand the description editor',
        'editor.use': 'Use',
        'editor.active': 'Active',
        'editor.rename': 'Rename persona',
        'editor.image': 'Change image',
        'editor.duplicate': 'Duplicate persona',
        'editor.duplicateShort': 'Duplicate',
        'editor.delete': 'Delete persona',
        'editor.title': 'Title',
        'editor.description': 'Description',
        'editor.tokens': 'tokens',
        'editor.position': 'Position',
        'editor.pos.inPrompt': 'In Story String / Prompt',
        'editor.pos.topAn': "Top of Author's Note",
        'editor.pos.bottomAn': "Bottom of Author's Note",
        'editor.pos.atDepth': 'In-chat @ Depth',
        'editor.pos.none': 'None (disabled)',
        'editor.depth': 'Depth',
        'editor.role': 'Role',
        'editor.role.system': 'System',
        'editor.role.user': 'User',
        'editor.role.assistant': 'Assistant',
        'editor.connections': 'Connections',
        'editor.locksHint': 'Use this persona first to change chat or character locks.',
        'editor.noConnections': 'No character connections yet.',
        'editor.lorebook': 'Lorebook',
        'editor.lorebook.none': 'None',
        'editor.openLorebook': 'Open lorebook',
        'editor.folder': 'Folder',
        'editor.notes': 'Private notes',
        'editor.notesPlaceholder': 'Notes visible only here, never sent to the model.',
        'editor.renamePrompt': 'Enter a new name for this persona:',
        'editor.duplicateConfirm': 'Duplicate persona "{name}"?',
        'editor.imageError': 'Failed to update the persona image.',
        'editor.duplicateError': 'Failed to duplicate the persona.',
    },
    ru: {
        'app.title': 'Менеджер персон',
        'persona.unnamed': '[Безымянная персона]',
        'action.close': 'Закрыть',
        'action.more': 'Другие действия',
        'toolbar.search': 'Поиск...',
        'toolbar.searchLabel': 'Поиск персон',
        'toolbar.sort': 'Сортировка персон',
        'sort.az': 'Имя А-Я',
        'sort.za': 'Имя Я-А',
        'sort.newest': 'Сначала новые',
        'sort.oldest': 'Сначала старые',
        'sort.recent': 'Недавно использованные',
        'filter.heading': 'Быстрые фильтры',
        'filter.all': 'Все',
        'filter.active': 'Активная',
        'filter.default': 'По умолчанию',
        'filter.locked': 'Привязанные',
        'filter.favorites': 'Избранное',
        'pager.prev': 'Предыдущая страница',
        'pager.next': 'Следующая страница',
        'pager.range': '{from}–{to} из {total}',
        'status.empty': 'Нет персон, подходящих под этот вид.',
        'spotlight.heading': 'Текущая персона',
        'spotlight.edit': 'Редактировать текущую персону: {name}',
        'spotlight.none': 'Персона не выбрана',
        'lock.chat': 'Чат',
        'lock.character': 'Персонаж',
        'lock.default': 'По умолчанию',
        'action.favorite': 'В избранное',
        'card.active': 'Активна',
        'card.use': 'Использовать персону: {name}',
        'card.select': 'Выбрать персону: {name}',
        'card.edit': 'Редактировать',
        'card.delete': 'Удалить персону',
        'card.favoriteFor': 'В избранное: {name}',
        'card.editFor': 'Редактировать персону: {name}',
        'card.deleteConfirm': 'Удалить персону «{name}»? Это действие необратимо.',
        'card.deleteError': 'Не удалось удалить персону.',
        'folder.all': 'Все персоны',
        'folder.unfiled': 'Несортированное',
        'folder.heading': 'Папки',
        'folder.toggle': 'Показать или скрыть папки',
        'folder.new': 'Новая папка',
        'folder.namePrompt': 'Введите название новой папки:',
        'folder.rename': 'Переименовать папку',
        'folder.pickPrompt': 'Переместить в папку:',
        'folder.delete': 'Удалить папку',
        'folder.deleteConfirm': 'Удалить папку «{name}»? Персоны из неё переместятся в «Несортированное».',
        'select.toggle': 'Выбрать',
        'select.all': 'Выбрать все',
        'select.cancel': 'Отмена',
        'select.move': 'Переместить',
        'select.favorite': 'В избранное',
        'select.export': 'Экспорт',
        'select.delete': 'Удалить',
        'select.count': 'Выбрано: {n}',
        'select.deleteConfirm': 'Удалить персон ({n})? Это действие необратимо.',
        'backup.export': 'Резервная копия персон (.zip)',
        'backup.import': 'Восстановить персон (.zip)',
        'backup.empty': 'Нет персон для резервной копии.',
        'backup.noZip': 'Библиотека ZIP недоступна.',
        'backup.invalid': 'Недопустимый или нечитаемый файл резервной копии.',
        'backup.exported': 'Сохранено персон: {n}.',
        'backup.exportedPartial': 'Готово, но не удалось сохранить изображений: {n}.',
        'backup.restored': 'Восстановлено персон: {n} (пропущено: {skipped}).',
        'backup.restoredPartial': 'Восстановлено персон: {n}; не удалось изображений: {f}.',
        'backup.progressExport': 'Создание резервной копии…',
        'backup.progressZip': 'Сжатие…',
        'backup.progressImport': 'Восстановление персон…',
        'convert.btn': 'Персонаж → персона',
        'convert.prompt': 'Какого персонажа преобразовать в персону?',
        'convert.empty': 'Нет персонажей для преобразования.',
        'convert.error': 'Не удалось преобразовать персонажа в персону.',
        'create.btn': 'Создать персону',
        'create.short': 'Создать',
        'create.namePrompt': 'Введите имя для этой персоны:',
        'create.nameLabel': 'Заголовок персоны (необязательно, только для отображения)',
        'create.avatarLabel': 'Аватар (необязательно)',
        'create.avatarDefault': 'Стандартное изображение',
        'create.avatarPick': 'Выбрать фото',
        'create.avatarReset': 'Сбросить фото',
        'create.error': 'Не удалось создать персону.',
        'crop.title': 'Обрезка аватара',
        'crop.hint': 'Перетащите рамку для кадрирования или выберите пропорции ниже.',
        'crop.aspectLabel': 'Пропорции обрезки',
        'crop.free': 'Свободно',
        'crop.cardRatio': 'Текущие пропорции карточек',
        'crop.apply': 'Применить',
        'settings.intro': 'Более красивый и удобный для мобильных способ управлять персонами.',
        'settings.open': 'Открыть Менеджер Персон',
        'settings.behaviorHeading': 'Поведение',
        'settings.hijack': 'Открывать менеджер вместо стандартной панели персон',
        'settings.hijackDesc': 'Нажатие на кнопку панели управления персонами открывает этот менеджер.',
        'settings.cropOnUpload': 'Обрезать аватары при загрузке',
        'settings.cropOnUploadDesc': 'Открывать окно обрезки перед сохранением нового изображения персоны.',
        'settings.displayHeading': 'Отображение',
        'settings.gridColumns': 'Карточек в ряду',
        'settings.gridColumnsDesc': 'Максимум на больших экранах; в узких областях столбцов меньше. На мобильных два столбца.',
        'settings.aspectRatio': 'Пропорции изображений',
        'settings.aspectRatioDesc': 'Пропорции аватаров на компьютере и телефоне.',
        'settings.grid.auto': 'Авто',
        'settings.pageSize': 'Персон на странице',
        'settings.pageSizeDesc': 'Меньше на странице — быстрее работает большая библиотека.',
        'settings.themeHeading': 'Оформление',
        'settings.theme': 'Тема менеджера',
        'settings.themeDesc': 'Цветовая схема окна менеджера.',
        'theme.pick': 'Тема',
        'theme.native': 'Стандартная',
        'theme.githubDark': 'GitHub Dark',
        'theme.light': 'Светлая',
        'theme.dracula': 'Dracula',
        'theme.solarizedDark': 'Solarized Dark',
        'theme.nord': 'Nord',
        'editor.back': 'Назад',
        'editor.heading': 'Редактор персоны',
        'editor.saving': 'Ожидает сохранения',
        'editor.autosave': 'Автосохранение',
        'editor.close': 'Закрыть редактор',
        'editor.expand': 'На весь экран',
        'editor.collapse': 'Свернуть',
        'editor.expandDesc': 'Развернуть редактор описания',
        'editor.use': 'Выбрать',
        'editor.active': 'Активна',
        'editor.rename': 'Переименовать персону',
        'editor.image': 'Сменить изображение',
        'editor.duplicate': 'Дублировать персону',
        'editor.duplicateShort': 'Дублировать',
        'editor.delete': 'Удалить персону',
        'editor.title': 'Заголовок',
        'editor.description': 'Описание',
        'editor.tokens': 'токенов',
        'editor.position': 'Позиция',
        'editor.pos.inPrompt': 'В строке истории / промпте',
        'editor.pos.topAn': 'Вверху заметок автора',
        'editor.pos.bottomAn': 'Внизу заметок автора',
        'editor.pos.atDepth': 'В чате на глубине',
        'editor.pos.none': 'Отключено',
        'editor.depth': 'Глубина',
        'editor.role': 'Роль',
        'editor.role.system': 'Система',
        'editor.role.user': 'Пользователь',
        'editor.role.assistant': 'Ассистент',
        'editor.connections': 'Связи',
        'editor.locksHint': 'Сначала выберите эту персону, чтобы менять привязки к чату или персонажу.',
        'editor.noConnections': 'Пока нет связей с персонажами.',
        'editor.lorebook': 'Лорбук',
        'editor.lorebook.none': 'Нет',
        'editor.openLorebook': 'Открыть лорбук',
        'editor.folder': 'Папка',
        'editor.notes': 'Личные заметки',
        'editor.notesPlaceholder': 'Заметки видны только здесь и не отправляются модели.',
        'editor.renamePrompt': 'Введите новое имя для этой персоны:',
        'editor.duplicateConfirm': 'Дублировать персону «{name}»?',
        'editor.imageError': 'Не удалось обновить изображение персоны.',
        'editor.duplicateError': 'Не удалось дублировать персону.',
    },
};

let LANG = 'en';

function detectLang() {
    const candidates = [];
    try {
        const c = getContext();
        if (c && typeof c.getCurrentLocale === 'function') candidates.push(c.getCurrentLocale());
        candidates.push(c?.powerUserSettings?.locale);
    } catch (_) { /* ignore */ }
    try { candidates.push(localStorage.getItem('language')); } catch (_) { /* ignore */ }
    for (const raw of candidates) {
        if (typeof raw !== 'string' || !raw) continue;
        if (raw.toLowerCase().split(/[-_]/)[0] === 'ru') return 'ru';
    }
    return 'en';
}

function t(key, params) {
    let str = (I18N[LANG] && I18N[LANG][key]) ?? I18N.en[key] ?? key;
    if (params) {
        str = str.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    }
    return str;
}

function i18nApplyDom(root) {
    if (!root) return;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    const attrs = [['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria-label', 'aria-label']];
    for (const [dataAttr, realAttr] of attrs) {
        if (root.hasAttribute(dataAttr)) root.setAttribute(realAttr, t(root.getAttribute(dataAttr)));
        root.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
            el.setAttribute(realAttr, t(el.getAttribute(dataAttr)));
        });
    }
    root.querySelectorAll('button[title]:not([aria-label]), [role="button"][title]:not([aria-label])').forEach((el) => {
        el.setAttribute('aria-label', el.title);
    });
    root.querySelectorAll('button i').forEach((el) => el.setAttribute('aria-hidden', 'true'));
}

/** Lazily get-or-create settings, back-filling defaults. */
function getSettings() {
    if (!extension_settings[MODULE_SETTINGS_KEY] || typeof extension_settings[MODULE_SETTINGS_KEY] !== 'object') {
        extension_settings[MODULE_SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE_SETTINGS_KEY];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(k in s)) s[k] = structuredClone(v);
    }
    s.hijackDrawer = Boolean(s.hijackDrawer);
    s.cropOnUpload = Boolean(s.cropOnUpload);
    s.gridColumns = GRID_COLUMNS.includes(String(s.gridColumns)) ? String(s.gridColumns) : DEFAULT_SETTINGS.gridColumns;
    if (!ASPECT_RATIOS.includes(s.aspectRatio)) s.aspectRatio = DEFAULT_SETTINGS.aspectRatio;
    if (!PAGE_SIZES.includes(Number(s.pageSize))) s.pageSize = DEFAULT_SETTINGS.pageSize;
    if (!SORT_MODES.includes(s.sort)) s.sort = DEFAULT_SETTINGS.sort;
    if (!THEMES.includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
    return s;
}

function saveSettings() {
    state.savePending = true;
    setSaveStatus('editor.saving');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 500);
}

/** Submit queued changes before blur/teardown instead of waiting for debounce. */
function flushSave() {
    if (!state.savePending) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.savePending = false;
    stSaveSettings();
    setSaveStatus('editor.autosave');
}

function setSaveStatus(key) {
    state.saveStatus = key;
    const text = key ? t(key) : '';
    if (state.dom.saveStatus && state.dom.saveStatus.textContent !== text) state.dom.saveStatus.textContent = text;
}

/** Inject the settings panel into the extensions tab. */
async function injectSettingsPanel() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    const $node = $(html);
    $('#extensions_settings').append($node);
    if ($node[0]) i18nApplyDom($node[0]);
    bindSettingsUI();
}

function bindSettingsUI() {
    const s = getSettings();
    const $hijack = $('#pm_hijack_drawer');
    $hijack.prop('checked', !!s.hijackDrawer);
    $hijack.off('change.pm').on('change.pm', function () {
        s.hijackDrawer = $(this).prop('checked');
        if (s.hijackDrawer) hijackPersonaDrawer();
        saveSettings();
    });

    const $crop = $('#pm_crop_on_upload');
    $crop.prop('checked', !!s.cropOnUpload);
    $crop.off('change.pm').on('change.pm', function () {
        s.cropOnUpload = $(this).prop('checked');
        saveSettings();
    });

    const $grid = $('#pm_grid_columns');
    $grid.val(s.gridColumns);
    $grid.off('change.pm').on('change.pm', function () {
        const val = String($(this).val());
        s.gridColumns = GRID_COLUMNS.includes(val) ? val : DEFAULT_SETTINGS.gridColumns;
        $(this).val(s.gridColumns);
        saveSettings();
        applyGridLayout();
    });

    const $ratio = $('#pm_aspect_ratio');
    $ratio.val(s.aspectRatio);
    $ratio.off('change.pm').on('change.pm', function () {
        const val = String($(this).val());
        s.aspectRatio = ASPECT_RATIOS.includes(val) ? val : DEFAULT_SETTINGS.aspectRatio;
        $(this).val(s.aspectRatio);
        saveSettings();
        applyGridLayout();
    });

    const $page = $('#pm_page_size');
    $page.val(String(s.pageSize));
    $page.off('change.pm').on('change.pm', function () {
        const val = Number($(this).val());
        s.pageSize = PAGE_SIZES.includes(val) ? val : DEFAULT_SETTINGS.pageSize;
        saveSettings();
        if (state.isOpen) { state.pageSize = s.pageSize; state.currentPage = 1; renderGrid({ resetScroll: true }); }
    });

    const grid = document.getElementById('pm_theme_grid');
    if (grid) renderThemeSwatches(grid, pickTheme);

    $('#pm_open_button').off('click.pm').on('click.pm', () => openManager());
}

/** Persist + apply a theme choice and keep every visible picker in sync. */
function pickTheme(id) {
    if (!THEMES.includes(id)) return;
    getSettings().theme = id;
    saveSettings();
    applyTheme();
    syncThemeSwatchMarkers();
}

function isThemeMenuOpen() {
    return state.dom.themeMenu && !state.dom.themeMenu.classList.contains('pm_hidden');
}

function openThemeMenu() {
    const d = state.dom;
    if (!d.themeMenu) return;
    renderThemeSwatches(d.themeMenuGrid, (id) => { pickTheme(id); closeThemeMenu(); });
    d.themeMenu.classList.remove('pm_hidden');
    d.themeBtn?.setAttribute('aria-expanded', 'true');
    d.themeMenuGrid?.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
}

function closeThemeMenu() {
    const d = state.dom;
    if (!d.themeMenu) return;
    const restoreFocus = d.themeMenu.contains(document.activeElement);
    d.themeMenu.classList.add('pm_hidden');
    d.themeBtn?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (d.themeBtn?.offsetParent ? d.themeBtn : d.moreBtn)?.focus({ preventScroll: true });
}

function toggleThemeMenu() {
    if (isThemeMenuOpen()) closeThemeMenu();
    else openThemeMenu();
}

function isMoreMenuOpen() {
    return state.dom.moreMenu?.classList.contains('is-open') || false;
}

function openMoreMenu() {
    state.dom.moreMenu?.classList.add('is-open');
    state.dom.moreBtn?.setAttribute('aria-expanded', 'true');
}

function closeMoreMenu() {
    const active = document.activeElement;
    state.dom.moreMenu?.classList.remove('is-open');
    state.dom.moreBtn?.setAttribute('aria-expanded', 'false');
    if (state.dom.moreMenu?.contains(active) && active.offsetParent === null) {
        state.dom.moreBtn?.focus({ preventScroll: true });
    }
}

function toggleMoreMenu() {
    if (isMoreMenuOpen()) closeMoreMenu();
    else openMoreMenu();
}

// ── Data & rendering ──────────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// ── Folders & favorites ───────────────────────────────────────────────────
function isFavorite(avatarId) {
    return getSettings().favorites.includes(avatarId);
}

function toggleFavorite(avatarId) {
    const favs = getSettings().favorites;
    const i = favs.indexOf(avatarId);
    if (i >= 0) favs.splice(i, 1);
    else favs.push(avatarId);
    saveSettings();
}

function assignToFolder(avatarId, folderId) {
    const s = getSettings();
    if (!folderId || folderId === FOLDER_UNFILED) delete s.assignments[avatarId];
    else s.assignments[avatarId] = folderId;
    saveSettings();
}

function createFolder(name) {
    const s = getSettings();
    const folder = { id: getContext().uuidv4(), name: String(name).trim(), sortOrder: s.folders.length };
    s.folders.push(folder);
    saveSettings();
    return folder;
}

function deleteFolder(folderId) {
    const s = getSettings();
    s.folders = s.folders.filter((f) => f.id !== folderId);
    for (const [id, fid] of Object.entries(s.assignments)) {
        if (fid === folderId) delete s.assignments[id];
    }
    if (state.activeFolderId === folderId) state.activeFolderId = FOLDER_ALL;
    saveSettings();
}

function renameFolder(folderId, name) {
    const folder = getSettings().folders.find((f) => f.id === folderId);
    if (!folder) return;
    folder.name = String(name).trim();
    saveSettings();
}

function countInFolder(folderId) {
    const list = state.avatars || [];
    if (folderId === FOLDER_ALL) return list.length;
    const { assignments } = getSettings();
    if (folderId === FOLDER_UNFILED) return list.filter((id) => !assignments[id]).length;
    return list.filter((id) => assignments[id] === folderId).length;
}

function hasFolders() {
    return getSettings().folders.length > 0;
}

function normalizeActiveFolder() {
    const folder = state.activeFolderId;
    if (folder === FOLDER_ALL || folder === FOLDER_UNFILED) return folder;
    if (getSettings().folders.some((f) => f.id === folder)) return folder;
    state.activeFolderId = FOLDER_ALL;
    return FOLDER_ALL;
}

/** Sort by the avatar's leading timestamp, then stored firstSeen, then 0. */
function personaTimestamp(avatarId, firstSeen) {
    const m = String(avatarId).match(/^(\d{10,})/);
    if (m) return Number(m[1]);
    const seen = firstSeen?.[avatarId];
    return typeof seen === 'number' ? seen : 0;
}

function isLockedPersona(avatarId) {
    const connections = power_user.persona_descriptions?.[avatarId]?.connections;
    return getContext().chatMetadata?.persona === avatarId || (Array.isArray(connections) && connections.length > 0);
}

function getVisiblePersonas() {
    const settings = getSettings();
    const favorites = new Set(settings.favorites);
    const assignments = settings.assignments;
    const term = state.search.trim().toLowerCase();
    let list = (state.avatars || []).map(personaMeta);

    // Folder filter (skipped while searching, so search spans the whole library).
    const folder = normalizeActiveFolder();
    if (!term && folder !== FOLDER_ALL) {
        if (folder === FOLDER_UNFILED) list = list.filter((p) => !assignments[p.id]);
        else list = list.filter((p) => assignments[p.id] === folder);
    }

    if (term) {
        list = list.filter((p) =>
            p.name.toLowerCase().includes(term) ||
            p.title.toLowerCase().includes(term) ||
            p.description.toLowerCase().includes(term));
    }

    switch (state.activeFilter) {
        case 'active':
            list = list.filter((p) => p.isCurrent);
            break;
        case 'default':
            list = list.filter((p) => p.isDefault);
            break;
        case 'locked':
            list = list.filter((p) => isLockedPersona(p.id));
            break;
        case 'favorites':
            list = list.filter((p) => favorites.has(p.id));
            break;
    }

    const cmp = (a, b) => a.name.localeCompare(b.name);
    switch (state.sort) {
        case 'za':
            list.sort((a, b) => cmp(b, a));
            break;
        case 'newest':
            list.sort((a, b) => personaTimestamp(b.id, settings.firstSeen) - personaTimestamp(a.id, settings.firstSeen) || cmp(a, b));
            break;
        case 'oldest':
            list.sort((a, b) => personaTimestamp(a.id, settings.firstSeen) - personaTimestamp(b.id, settings.firstSeen) || cmp(a, b));
            break;
        case 'recent': {
            const lastUsed = settings.lastUsed;
            list.sort((a, b) => (lastUsed[b.id] || 0) - (lastUsed[a.id] || 0) || cmp(a, b));
            break;
        }
        case 'az':
        default:
            list.sort(cmp);
            break;
    }

    // Favorites take priority except when sorting by recent use.
    if (state.sort !== 'recent') {
        list.sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)));
    }
    return list;
}

function setActiveFilter(filter) {
    state.activeFilter = FILTER_MODES.includes(filter) ? filter : 'all';
    state.currentPage = 1;
    state.dom.filters?.querySelectorAll('[data-pm-filter]').forEach((btn) => {
        const active = btn.dataset.pmFilter === state.activeFilter;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
    });
    renderGrid({ resetScroll: true });
}

function totalPages(count) {
    return Math.max(1, Math.ceil(count / state.pageSize));
}

function lockBadgesHtml(meta) {
    return [
        ['chat', 'chat', 'comment', meta.isCurrent && isPersonaLocked('chat')],
        ['character', 'char', 'lock', meta.isCurrent && isPersonaLocked('character')],
        ['default', 'default', 'crown', meta.isDefault],
    ].filter(([, , , on]) => on).map(([type, chip, icon]) =>
        `<span class="pm_chip pm_chip_${chip}" role="img" title="${escapeHtml(t(`lock.${type}`))}" aria-label="${escapeHtml(t(`lock.${type}`))}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></span>`,
    ).join('');
}

/** Apply card proportions and columns without replacing image nodes. */
function applyGridLayout() {
    const grid = state.dom.grid;
    if (!grid) return;
    const s = getSettings();
    grid.dataset.columns = s.gridColumns;
    grid.style.setProperty('--pm-card-ratio', s.aspectRatio);
}

/**
 * Apply the chosen override theme to the modal. "native" removes the attribute
 * entirely so the SmartTheme-derived defaults remain untouched.
 */
function applyThemeToElement(el) {
    if (!el) return;
    const theme = getSettings().theme;
    if (!theme || theme === 'native') delete el.dataset.theme;
    else el.dataset.theme = theme;
}

function applyTheme() {
    applyThemeToElement(state.dom.modal);
}

function stylePopupDialog(dlg, extraClass = '') {
    if (!dlg) return;
    dlg.classList.add('pm-themed-popup');
    if (extraClass) dlg.classList.add(extraClass);
    applyThemeToElement(dlg);
    dlg.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.closest('button')) {
            e.stopPropagation();
        }
    });
}

/**
 * Render the theme swatch buttons into a container. Shared by the settings
 * panel grid and the in-modal palette popover. `onPick(id)` fires on selection.
 */
function renderThemeSwatches(container, onPick) {
    if (!container) return;
    const active = getSettings().theme;
    container.innerHTML = THEMES.map((id) => {
        const [bg, fg, ac] = THEME_SWATCHES[id];
        const isActive = id === active ? ' is-active' : '';
        return `
        <button type="button" class="pm_theme_swatch${isActive}" aria-pressed="${id === active}" data-pm-theme="${escapeHtml(id)}" style="--sw-bg:${bg};--sw-fg:${fg};--sw-ac:${ac};">
            <span class="pm_theme_preview" aria-hidden="true">
                <span class="pm_theme_line pm_theme_line_a"></span>
                <span class="pm_theme_line pm_theme_line_b"></span>
                <span class="pm_theme_line pm_theme_line_c"></span>
            </span>
            <span class="pm_theme_name">${escapeHtml(t(THEME_LABEL_KEYS[id]))}</span>
            <i class="pm_theme_check fa-solid fa-circle-check" aria-hidden="true"></i>
        </button>`;
    }).join('');
    container.querySelectorAll('[data-pm-theme]').forEach((btn) => {
        btn.addEventListener('click', () => onPick(btn.getAttribute('data-pm-theme')));
    });
}

/** Refresh the active-swatch marker in any rendered theme picker. */
function syncThemeSwatchMarkers() {
    const active = getSettings().theme;
    document.querySelectorAll('[data-pm-theme]').forEach((btn) => {
        const on = btn.getAttribute('data-pm-theme') === active;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', String(on));
    });
}

function renderGrid({ resetScroll = false } = {}) {
    const grid = state.dom.grid;
    if (!grid) return;
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.closest('.pm_card')?.dataset.avatarId;
    const focusSelector = focused?.hasAttribute('data-pm-fav') ? '[data-pm-fav]'
        : focused?.dataset.pmCard ? `[data-pm-card="${CSS.escape(focused.dataset.pmCard)}"]` : '.pm_card_pick';
    const scrollTop = resetScroll ? 0 : grid.scrollTop;
    applyGridLayout();

    const all = getVisiblePersonas();
    const pages = totalPages(all.length);
    state.currentPage = Math.min(Math.max(1, state.currentPage), pages);
    const start = (state.currentPage - 1) * state.pageSize;
    const pageItems = all.slice(start, start + state.pageSize);

    const fragment = document.createDocumentFragment();
    for (const meta of pageItems) {
        const card = document.createElement('div');
        card.className = 'pm_card';
        if (meta.isCurrent) card.classList.add('is-active');
        if (meta.isDefault) card.classList.add('is-default');
        if (state.selected.has(meta.id)) card.classList.add('is-selected');
        card.dataset.avatarId = meta.id;
        card.draggable = !state.selectMode;
        card.title = meta.title ? `${meta.name} — ${meta.title}` : meta.name;
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', meta.name);
        const fav = isFavorite(meta.id);
        const checked = state.selected.has(meta.id);
        card.innerHTML = `
            <button type="button" class="pm_card_pick" aria-label="${escapeHtml(t(state.selectMode ? 'card.select' : 'card.use', { name: meta.name }))}" aria-pressed="${state.selectMode ? checked : meta.isCurrent}">
            <span class="pm_card_cover">
                <img src="${escapeHtml(personaImageUrl(meta.id))}" alt="" draggable="false" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${FALLBACK_AVATAR_URL}';" />
                <span class="pm_card_check" aria-hidden="true">
                    <i class="fa-${checked ? 'solid fa-square-check' : 'regular fa-square'}"></i>
                </span>
                <span class="pm_card_body">
                    <span class="pm_card_name">${meta.isCurrent ? `<i class="pm_card_active fa-solid fa-circle-check" title="${escapeHtml(t('card.active'))}" aria-hidden="true"></i>` : ''}${escapeHtml(meta.name)}</span>
                    <span class="pm_card_title"${meta.title ? '' : ' hidden'}>${escapeHtml(meta.title)}</span>
                </span>
            </span>
            </button>
            <div class="pm_card_meta">
                <span class="pm_card_badges">${lockBadgesHtml(meta)}</span>
                <div class="pm_card_quick">
                    <button type="button" class="pm_card_icon_btn pm_card_fav ${fav ? 'is-on' : ''}" data-pm-fav="${escapeHtml(meta.id)}" title="${escapeHtml(t('action.favorite'))}" aria-label="${escapeHtml(t('card.favoriteFor', { name: meta.name }))}" aria-pressed="${fav}">
                        <i class="fa-${fav ? 'solid' : 'regular'} fa-star" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="pm_card_icon_btn pm_card_edit" data-pm-card="edit" title="${escapeHtml(t('card.edit'))}" aria-label="${escapeHtml(t('card.editFor', { name: meta.name }))}">
                        <i class="fa-solid fa-pencil" aria-hidden="true"></i>
                    </button>
                </div>
            </div>`;
        fragment.appendChild(card);
    }
    grid.replaceChildren(fragment);

    const isEmpty = all.length === 0;
    state.dom.empty.classList.toggle('pm_hidden', !isEmpty);
    grid.classList.toggle('pm_hidden', isEmpty);
    if (isEmpty) state.dom.empty.textContent = t('status.empty');

    updateSelectUI();
    renderPager(pages, all.length);
    grid.scrollTop = scrollTop;
    if (focused) {
        const card = focusedId && grid.querySelector(`.pm_card[data-avatar-id="${CSS.escape(focusedId)}"]`);
        (card?.querySelector(focusSelector) || (isEmpty ? state.dom.search : grid))?.focus({ preventScroll: true });
    }
}

function renderPager(pages, total) {
    const pager = state.dom.pager;
    if (!pager) return;
    pager.classList.toggle('pm_hidden', pages <= 1);
    state.dom.pagerLabel.textContent = `${state.currentPage} / ${pages}`;
    state.dom.pagerPrev.disabled = state.currentPage <= 1;
    state.dom.pagerNext.disabled = state.currentPage >= pages;
    if (state.dom.pagerRange) {
        if (total > 0) {
            const from = (state.currentPage - 1) * state.pageSize + 1;
            const to = Math.min(state.currentPage * state.pageSize, total);
            state.dom.pagerRange.textContent = t('pager.range', { from, to, total });
        } else {
            state.dom.pagerRange.textContent = '';
        }
    }
}

function renderSpotlight() {
    const el = state.dom.spotlight;
    if (!el) return;
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const focusedLock = focused?.dataset.pmLock;
    const id = user_avatar;
    if (!id) {
        el.innerHTML = `<div class="pm_spotlight_empty">${escapeHtml(t('spotlight.none'))}</div>`;
        return;
    }
    const meta = personaMeta(id);
    el.innerHTML = `
        <button type="button" class="pm_spotlight_pick" data-pm-action="edit-current" title="${escapeHtml(t('card.edit'))}" aria-label="${escapeHtml(t('spotlight.edit', { name: meta.name }))}">
        <span class="pm_spotlight_avatar">
            <img src="${escapeHtml(personaImageUrl(id))}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_AVATAR_URL}';" />
        </span>
        <span class="pm_spotlight_info">
            <span class="pm_spotlight_name" title="${escapeHtml(meta.name)}">${escapeHtml(meta.name)}</span>
            <span class="pm_spotlight_title" title="${escapeHtml(meta.title)}"${meta.title ? '' : ' hidden'}>${escapeHtml(meta.title)}</span>
        </span>
        <i class="pm_spotlight_edit fa-solid fa-pencil" aria-hidden="true"></i>
        </button>
        <div class="pm_spotlight_locks">
            ${[['chat', 'comment'], ['character', 'user-lock'], ['default', 'crown']].map(([type, icon]) => {
                const on = isPersonaLocked(type);
                const label = escapeHtml(t(`lock.${type}`));
                return `<button type="button" class="pm_lock_btn ${on ? 'is-on' : ''}" data-pm-lock="${type}" title="${label}" aria-label="${label}" aria-pressed="${on}">
                    <i class="fa-solid fa-${icon}" aria-hidden="true"></i>
                </button>`;
            }).join('')}
        </div>`;
    if (focusedLock) el.querySelector(`[data-pm-lock="${CSS.escape(focusedLock)}"]`)?.focus({ preventScroll: true });
    else if (focused) el.querySelector('.pm_spotlight_pick')?.focus({ preventScroll: true });
}

function folderRowHtml(id, label, icon, { fixed = false } = {}) {
    const active = state.activeFolderId === id ? ' is-active' : '';
    const count = countInFolder(id);
    const tools = fixed ? '' : `
            <div class="pm_folder_tools">
                <button type="button" class="pm_folder_tool" data-folder-rename="${escapeHtml(id)}" title="${escapeHtml(t('folder.rename'))}" aria-label="${escapeHtml(t('folder.rename'))}"><i class="fa-solid fa-pencil"></i></button>
                <button type="button" class="pm_folder_tool pm_folder_tool_danger" data-folder-del="${escapeHtml(id)}" title="${escapeHtml(t('folder.delete'))}" aria-label="${escapeHtml(t('folder.delete'))}"><i class="fa-solid fa-trash-can"></i></button>
            </div>`;
    return `
        <div class="pm_folder_row${active}" data-folder-id="${escapeHtml(id)}">
            <button type="button" class="pm_folder_pick" aria-pressed="${!!active}">
            <i class="fa-solid ${icon} pm_folder_icon" aria-hidden="true"></i>
            <span class="pm_folder_name">${escapeHtml(label)}</span>
            <span class="pm_folder_count">${count}</span>
            </button>${tools}
        </div>`;
}

function renderSidebar() {
    const el = state.dom.folderList;
    if (!el) return;
    normalizeActiveFolder();
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.closest('[data-folder-id]')?.dataset.folderId;
    const focusSelector = focused?.hasAttribute('data-folder-rename') ? '[data-folder-rename]'
        : focused?.hasAttribute('data-folder-del') ? '[data-folder-del]' : '.pm_folder_pick';
    const s = getSettings();
    const folders = [...s.folders].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    let html = '';
    html += folderRowHtml(FOLDER_ALL, t('folder.all'), 'fa-layer-group', { fixed: true });
    html += folderRowHtml(FOLDER_UNFILED, t('folder.unfiled'), 'fa-inbox', { fixed: true });
    if (folders.length) html += `<div class="pm_folder_divider">${escapeHtml(t('folder.heading'))}</div>`;
    for (const f of folders) html += folderRowHtml(f.id, f.name, 'fa-folder');
    el.innerHTML = html;
    el.querySelectorAll('button i').forEach((icon) => icon.setAttribute('aria-hidden', 'true'));
    if (focusedId) {
        const row = el.querySelector(`[data-folder-id="${CSS.escape(focusedId)}"]`);
        (row?.querySelector(focusSelector) || state.dom.search)?.focus({ preventScroll: true });
    }
}

function isSidebarOpen() {
    return Boolean(state.dom.sidebar && !state.dom.sidebar.classList.contains('is-collapsed'));
}

function setSidebarOpen(open, { remember = false } = {}) {
    const { sidebar, content, sidebarToggle } = state.dom;
    if (!sidebar) return;
    const restoreFocus = !open && sidebar.contains(document.activeElement);
    sidebar.classList.toggle('is-collapsed', !open);
    content?.classList.toggle('pm-sidebar-open', open);
    sidebarToggle?.classList.toggle('is-active', open);
    sidebarToggle?.setAttribute('aria-expanded', String(open));
    sidebarToggle?.setAttribute('aria-pressed', String(open));
    if (remember && !isMobileLayout()) state.sidebarPreference = open;
    if (restoreFocus) sidebarToggle?.focus({ preventScroll: true });
}

function applyFolderLayout() {
    if (!state.dom.sidebar) return;
    if (!isMobileLayout()) {
        setSidebarOpen(state.sidebarPreference ?? hasFolders());
    } else {
        setSidebarOpen(isSidebarOpen());
    }
}

async function refresh() {
    const generation = state.openGeneration;
    const loadGeneration = ++state.avatarLoadGeneration;
    const list = await getUserAvatars(false);
    if (!state.isOpen || generation !== state.openGeneration || loadGeneration !== state.avatarLoadGeneration) return false;
    state.avatars = Array.isArray(list) ? list : [];
    const ids = new Set(state.avatars);
    for (const id of state.selected) {
        if (!ids.has(id)) state.selected.delete(id);
    }
    applyFolderLayout();
    renderSidebar();
    renderSpotlight();
    renderGrid();
    if (state.editorId) {
        if (ids.has(state.editorId)) renderEditor();
        else closeEditor({ commit: false });
    }
    return true;
}

// ── Actions ───────────────────────────────────────────────────────────────
async function selectPersona(avatarId) {
    const wasCurrent = avatarId === user_avatar;
    await setUserAvatar(avatarId);
    // Changed personas are recorded through PERSONA_CHANGED. Reselecting the
    // active card emits no event, so record that one directly.
    if (wasCurrent) {
        recordPersonaUse(avatarId);
        if (state.sort === 'recent') renderGrid();
    }
}

function recordPersonaUse(avatarId) {
    if (!avatarId || !power_user.personas?.[avatarId]) return;
    getSettings().lastUsed[avatarId] = Date.now();
    saveSettings();
}

async function toggleLock(type) {
    await togglePersonaLock(type);
    renderSpotlight();
    renderGrid();
    if (state.editorId) renderEditor();
}

// ── Native bridge (operations not exported by personas.js) ────────────────
/**
 * Delete a persona by driving ST's own delete API. Uses the avatars endpoint
 * directly + clears power_user entries, mirroring core deletePersona, then lets
 * the PERSONA_DELETED reload path refresh us.
 */
async function deletePersonaViaNative(avatarId) {
    const ctx = getContext();
    try {
        const res = await fetch('/api/avatars/delete', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar: avatarId }),
        });
        if (!res.ok) return false;
        state.avatarLoadGeneration++;
        state.selected.delete(avatarId);
        const wasCurrent = avatarId === user_avatar;
        if (ctx.chatMetadata?.persona === avatarId) {
            delete ctx.chatMetadata.persona;
            await ctx.saveMetadata?.();
        }
        if (state.editorId === avatarId) closeEditor({ commit: false });
        delete power_user.personas[avatarId];
        delete power_user.persona_descriptions[avatarId];
        if (power_user.default_persona === avatarId) power_user.default_persona = null;
        // Clean our own metadata too.
        const s = getSettings();
        delete s.assignments[avatarId];
        const fi = s.favorites.indexOf(avatarId);
        if (fi >= 0) s.favorites.splice(fi, 1);
        delete s.notes[avatarId];
        delete s.firstSeen[avatarId];
        delete s.lastUsed[avatarId];
        saveSettings();
        ctx.saveSettingsDebounced();
        const knownAvatars = state.avatars || await getUserAvatars(false);
        state.avatars = (Array.isArray(knownAvatars) ? knownAvatars : []).filter((id) => id !== avatarId);
        if (wasCurrent && state.avatars.length) {
            const fallback = state.avatars.includes(power_user.default_persona)
                ? power_user.default_persona
                : state.avatars[0];
            await setUserAvatar(fallback, { toastPersonaNameChange: false });
        }
        await eventSource.emit(event_types.PERSONA_DELETED, { avatarId, name: '' });
        return true;
    } catch (_) {
        return false;
    }
}

// ── Backup / Restore (ZIP: personas.json + persona-images/) ───────────────
// Uses ST's bundled JSZip for native persona JSON and avatar images.

async function ensureZip() {
    if (window.JSZip) return true;
    const ok = await new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = '/lib/jszip.min.js';
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
    });
    return ok && !!window.JSZip;
}

function downloadBlob(blob, name) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

function backupStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

// Circular progress overlay shown during export/import (r=19 → C≈119.38).
const PROGRESS_CIRC = 2 * Math.PI * 19;

function showProgress(label) {
    const d = state.dom;
    if (!d.progress) return;
    if (d.progressArc) {
        d.progressArc.style.strokeDasharray = String(PROGRESS_CIRC);
        d.progressArc.style.strokeDashoffset = String(PROGRESS_CIRC);
    }
    if (d.progressPct) d.progressPct.textContent = '0%';
    if (d.progressLabel) d.progressLabel.textContent = label || '';
    d.progress.classList.remove('pm_hidden');
    setOverlayBlocked(true);
}

function setProgress(done, total, label) {
    const d = state.dom;
    if (!d.progress) return;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (d.progressArc) d.progressArc.style.strokeDashoffset = String(PROGRESS_CIRC * (1 - pct / 100));
    if (d.progressPct) d.progressPct.textContent = `${pct}%`;
    if (label && d.progressLabel) d.progressLabel.textContent = label;
}

function hideProgress() {
    state.dom.progress?.classList.add('pm_hidden');
    setOverlayBlocked(false);
}

/** Make the panel behind the progress overlay inert for pointer, keyboard and AT. */
function setOverlayBlocked(on) {
    const panel = state.dom.modal?.querySelector('.pm_panel');
    const progress = state.dom.progress;
    if (!panel || !progress) return;
    if (on && panel.contains(document.activeElement)) {
        state.overlayOpener = document.activeElement;
        state.dom.modal.focus({ preventScroll: true });
    }
    for (const child of panel.children) {
        if (child !== progress) child.inert = on;
    }
    if (!on) {
        const opener = state.overlayOpener;
        state.overlayOpener = null;
        if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
        else if (state.isOpen) state.dom.modal?.focus({ preventScroll: true });
    }
}

// Yield to the event loop so the progress UI can paint between steps.
function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Build + download a ZIP for the given persona ids. Shared by full backup and
 * bulk export. The subset personas.json keeps the native backup shape so the
 * archive restores through the existing onRestoreFile path.
 */
async function exportPersonasZip(ids, filename) {
    if (state.busy) return;
    if (!Array.isArray(ids) || !ids.length) { toastr.info(t('backup.empty')); return; }
    if (!(await ensureZip())) { toastr.error(t('backup.noZip')); return; }
    const ctx = getContext();
    state.busy = true;

    const personas = {};
    const descriptions = {};
    for (const id of ids) {
        if (id in power_user.personas) personas[id] = power_user.personas[id];
        if (power_user.persona_descriptions?.[id]) descriptions[id] = power_user.persona_descriptions[id];
    }

    const zip = new window.JSZip();
    zip.file('personas/personas.json', JSON.stringify({
        kind: 'personas-backup',
        schema: 1,
        count: ids.length,
        default_persona: power_user.default_persona ?? null,
        personas,
        persona_descriptions: descriptions,
    }, null, 2));

    showProgress(t('backup.progressExport'));
    try {
        let imgFail = 0;
        const images = zip.folder('persona-images');
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            try {
                const path = getUserAvatar(id).split('/').map(encodeURIComponent).join('/');
                const r = await fetch(`/${path}`, { headers: ctx.getRequestHeaders(), cache: 'no-cache' });
                if (!r.ok) throw new Error(`fetch ${r.status}`);
                images.file(id, await r.blob());
            } catch (_) { imgFail++; }
            // Image collection occupies the first 90% of the bar.
            setProgress(Math.round((i + 1) / ids.length * 90), 100);
            if (i % 5 === 0) await nextFrame();
        }

        const blob = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
            (meta) => setProgress(90 + Math.round(meta.percent * 0.1), 100, t('backup.progressZip')),
        );
        downloadBlob(blob, filename);
        if (imgFail) toastr.warning(t('backup.exportedPartial', { n: imgFail }));
        else toastr.success(t('backup.exported', { n: ids.length }));
    } finally {
        hideProgress();
        state.busy = false;
    }
}

async function onBackup() {
    if (state.busy) return;
    const list = await getUserAvatars(false);
    const ids = Array.isArray(list) ? list : [];
    if (!ids.length) { toastr.info(t('backup.empty')); return; }
    await exportPersonasZip(ids, `personas-${backupStamp()}.zip`);
}

async function uploadAvatarBlob(avatarId, blob) {
    const ctx = getContext();
    const form = new FormData();
    form.append('avatar', blob, 'avatar.png');
    form.append('overwrite_name', avatarId);
    const res = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
        body: form,
    });
    if (!res.ok) throw new Error(`upload ${res.status}`);
    const data = await res.json().catch(() => null);
    return String(data?.path || avatarId);
}

// ── Avatar image decode & crop pipeline ───────────────────────────────────
function withDecodedImage(blob, fn) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            img.onload = img.onerror = null;
            img.src = '';
            URL.revokeObjectURL(url);
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const timer = setTimeout(() => fail(new Error('Image decode timed out')), 20000);
        img.onerror = () => fail(new Error('Failed to decode image'));
        img.onload = () => {
            if (settled) return;
            settled = true;
            try {
                if (!img.naturalWidth || !img.naturalHeight) throw new Error('Empty image');
                resolve(fn(img));
            } catch (err) {
                reject(err);
            } finally {
                cleanup();
            }
        };
        try { img.src = url; } catch (err) { fail(err); }
    });
}

function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        try {
            canvas.toBlob((blob) => {
                canvas.width = canvas.height = 0;
                if (blob) resolve(blob);
                else reject(new Error('Canvas export failed'));
            }, 'image/png');
        } catch (err) {
            canvas.width = canvas.height = 0;
            reject(err);
        }
    });
}

function rasterizeImageBlob(blob, maxDim, region = null) {
    return withDecodedImage(blob, (img) => {
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        let sx = 0;
        let sy = 0;
        let sw = nw;
        let sh = nh;
        if (region) {
            if (![region.x, region.y, region.width, region.height].every(Number.isFinite)
                || region.width <= 0 || region.height <= 0) {
                throw new Error('Invalid crop region');
            }
            sx = Math.max(0, Math.min(nw - 1, region.x * nw));
            sy = Math.max(0, Math.min(nh - 1, region.y * nh));
            sw = Math.max(1, Math.min(nw - sx, region.width * nw));
            sh = Math.max(1, Math.min(nh - sy, region.height * nh));
        }
        const scale = maxDim > 0 ? Math.min(1, maxDim / Math.max(sw, sh)) : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(sw * scale));
        canvas.height = Math.max(1, Math.round(sh * scale));
        try {
            canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        } catch (err) {
            canvas.width = canvas.height = 0;
            throw err;
        }
        return canvasToPngBlob(canvas);
    });
}

/**
 * Open a themed Cropper.js dialog for `file` and render the cropped region from
 * the original file to a bounded PNG Blob. Returns `null` on cancel.
 */
async function cropAvatarFile(file) {
    const previewDataUrl = await withDecodedImage(file, (img) => {
        const scale = Math.min(1, CROP_PREVIEW_DIM / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        try {
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/png');
        } finally {
            canvas.width = canvas.height = 0;
        }
    });

    const ctx = getContext();
    const cardRatioId = getSettings().aspectRatio;
    const defaultPreset = CROP_PRESETS.find((p) => p.id === cardRatioId) || CROP_PRESETS[0];

    const shell = document.createElement('div');
    shell.className = 'pm_crop_shell';
    const head = document.createElement('div');
    head.className = 'pm_crop_head';
    const titleEl = document.createElement('h3');
    titleEl.className = 'pm_crop_title';
    titleEl.textContent = t('crop.title');
    const hintEl = document.createElement('p');
    hintEl.className = 'pm_crop_hint';
    hintEl.textContent = t('crop.hint');
    head.append(titleEl, hintEl);

    const stage = document.createElement('div');
    stage.className = 'pm_crop_stage';

    const ratioBar = document.createElement('div');
    ratioBar.className = 'pm_crop_ratios';
    ratioBar.setAttribute('role', 'group');
    ratioBar.setAttribute('aria-label', t('crop.aspectLabel'));
    const ratioButtons = CROP_PRESETS.map((preset) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pm_crop_ratio interactable';
        btn.dataset.cropPreset = preset.id;
        const isDefault = preset.id === defaultPreset.id;
        btn.classList.toggle('is-active', isDefault);
        if (preset.id === cardRatioId) {
            btn.classList.add('is-card-ratio');
            btn.title = t('crop.cardRatio');
        }
        btn.setAttribute('aria-pressed', String(isDefault));
        btn.textContent = preset.labelKey ? t(preset.labelKey) : preset.label;
        ratioBar.appendChild(btn);
        return btn;
    });

    shell.append(head, stage, ratioBar);

    const popup = new ctx.Popup(shell, ctx.POPUP_TYPE?.CROP ?? 3, '', {
        cropImage: previewDataUrl,
        cropAspect: defaultPreset.ratio,
        okButton: t('crop.apply'),
        cancelButton: t('select.cancel'),
    });
    stylePopupDialog(popup.dlg, 'pm-crop-popup');
    popup.dlg.setAttribute('aria-label', t('crop.title'));
    stage.appendChild(popup.cropWrap);

    const cropper = $(popup.cropImage).data('cropper');
    const origGetCroppedCanvas = cropper?.getCroppedCanvas;
    if (!cropper || !origGetCroppedCanvas) {
        popup.dlg?.remove();
        const popups = ctx.Popup.util?.popups;
        const idx = popups?.indexOf(popup) ?? -1;
        if (idx >= 0) popups.splice(idx, 1);
        throw new Error('Cropper unavailable');
    }

    const image = cropper.image;
    let sizingImage = null;
    let finished = false;
    let applying = false;
    let exportedBlob = null;
    let rejectFailure;
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    const fail = (err) => {
        if (finished) return;
        finished = true;
        popup.okButton?.setAttribute('aria-disabled', 'true');
        if (popup.dlg?.open) popup.dlg.close();
        popup.dlg?.remove();
        const popups = ctx.Popup.util?.popups;
        const idx = popups?.indexOf(popup) ?? -1;
        if (idx >= 0) popups.splice(idx, 1);
        rejectFailure(err instanceof Error ? err : new Error('Crop failed'));
    };

    const syncReady = () => {
        if (finished) return;
        const ready = !applying && Boolean(cropper?.ready);
        popup.okButton?.setAttribute('aria-disabled', String(!ready));
        for (const btn of ratioButtons) btn.disabled = !ready;
    };

    ratioBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-crop-preset]');
        if (!btn || btn.disabled || !cropper?.ready) return;
        const preset = CROP_PRESETS.find((p) => p.id === btn.dataset.cropPreset);
        if (!preset) return;
        cropper.setAspectRatio(preset.ratio);
        for (const el of ratioButtons) {
            const on = el === btn;
            el.classList.toggle('is-active', on);
            el.setAttribute('aria-pressed', String(on));
        }
    });

    const stubCanvas = { toDataURL: () => 'data:image/png;base64,' };
    const origComplete = popup.complete;
    popup.complete = async (result) => {
        const affirmative = result >= (ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1);
        if (finished || (affirmative && (applying || !cropper?.ready))) return undefined;
        try {
            if (affirmative) {
                applying = true;
                syncReady();
                const crop = cropper.getData();
                const { naturalWidth, naturalHeight } = cropper.getImageData();
                if (!naturalWidth || !naturalHeight) throw new Error('Invalid crop source');
                exportedBlob = await rasterizeImageBlob(file, AVATAR_EXPORT_DIM, {
                    x: crop.x / naturalWidth,
                    y: crop.y / naturalHeight,
                    width: crop.width / naturalWidth,
                    height: crop.height / naturalHeight,
                });
                if (finished) return undefined;
                cropper.getCroppedCanvas = () => stubCanvas;
            }
            finished = true;
            return await origComplete.call(popup, result);
        } catch (err) {
            if (!finished) fail(err);
            return undefined;
        } finally {
            applying = false;
            syncReady();
        }
    };

    const onLoad = () => {
        sizingImage?.removeEventListener('error', fail);
        sizingImage = cropper?.sizingImage;
        sizingImage?.addEventListener('error', fail);
    };
    popup.onOpen = () => {
        if (!finished && cropper?.ready) cropper.resize();
    };
    popup.cropImage.addEventListener('ready', syncReady);
    popup.dlg.addEventListener('error', fail, true);
    image?.addEventListener('load', onLoad);
    syncReady();
    onLoad();

    try {
        const result = await Promise.race([popup.show(), failure]);
        if (result == null) return null;
        if (!exportedBlob) throw new Error('Missing cropped image');
        return exportedBlob;
    } finally {
        finished = true;
        popup.onOpen = null;
        popup.cropImage.removeEventListener('ready', syncReady);
        popup.dlg.removeEventListener('error', fail, true);
        image?.removeEventListener('load', onLoad);
        sizingImage?.removeEventListener('error', fail);
        if (cropper && origGetCroppedCanvas) cropper.getCroppedCanvas = origGetCroppedCanvas;
        cropper?.destroy();
    }
}

async function prepareAvatarUploadBlob(file) {
    if (!file) return null;
    if (getSettings().cropOnUpload) return cropAvatarFile(file);
    return rasterizeImageBlob(file, AVATAR_EXPORT_DIM);
}

async function onRestoreFile(file) {
    if (!file || state.busy) return;
    if (!(await ensureZip())) { toastr.error(t('backup.noZip')); return; }
    const ctx = getContext();

    let zip;
    try {
        zip = await window.JSZip.loadAsync(file);
    } catch (_) { toastr.error(t('backup.invalid')); return; }

    const jsonFile = zip.file('personas/personas.json');
    if (!jsonFile) { toastr.error(t('backup.invalid')); return; }

    let data;
    try {
        data = JSON.parse(await jsonFile.async('string'));
    } catch (_) { toastr.error(t('backup.invalid')); return; }

    if (!data || typeof data.personas !== 'object' || typeof data.persona_descriptions !== 'object') {
        toastr.error(t('backup.invalid'));
        return;
    }

    let added = 0;
    let skipped = 0;
    let imgFail = 0;

    state.busy = true;
    showProgress(t('backup.progressImport'));
    try {
        const entries = Object.entries(data.personas);
        for (let i = 0; i < entries.length; i++) {
            const [id, name] = entries[i];
            if (id in power_user.personas) { skipped++; }
            else {
                // Upload the bundled image first so the avatar id resolves on the server.
                const imgFile = zip.file(`persona-images/${id}`);
                if (imgFile) {
                    try { await uploadAvatarBlob(id, await imgFile.async('blob')); } catch (_) { imgFail++; }
                }
                power_user.personas[id] = name;
                const desc = data.persona_descriptions[id];
                if (desc && typeof desc === 'object') power_user.persona_descriptions[id] = desc;
                added++;
            }
            setProgress(i + 1, entries.length);
            if (i % 5 === 0) await nextFrame();
        }

        saveSettings();
        ctx.saveSettingsDebounced();
        if (added) {
            await eventSource.emit(event_types.PERSONA_CREATED, { avatarId: '', name: '' });
        }

        if (imgFail) toastr.warning(t('backup.restoredPartial', { n: added, f: imgFail }));
        else toastr.success(t('backup.restored', { n: added, skipped }));
    } finally {
        hideProgress();
        state.busy = false;
    }
}

// ── Create persona ────────────────────────────────────────────────────────
/**
 * Create a persona: prompt for name (+ optional title + optional avatar with
 * crop/preview), mint an avatar id, upload the avatar, and open the editor.
 */
async function onCreate() {
    if (state.busy) return;
    const generation = state.openGeneration;
    const editorId = state.editorId;
    const ctx = getContext();

    const popup = new ctx.Popup(t('create.namePrompt'), ctx.POPUP_TYPE?.INPUT ?? 4, '', {
        customInputs: [{ id: 'persona_title', type: 'text', label: t('create.nameLabel') }],
        okButton: t('create.btn'),
        cancelButton: t('select.cancel'),
    });
    stylePopupDialog(popup.dlg);

    const defaultAvatarSrc = default_user_avatar ? `/${default_user_avatar}` : FALLBACK_AVATAR_URL;
    let pickedBlob = null;
    let previewUrl = '';
    let pickingImage = false;
    const revokePreview = () => {
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            previewUrl = '';
        }
    };

    const avatarRow = document.createElement('div');
    avatarRow.className = 'pm-create-avatar-row';
    const previewWrap = document.createElement('div');
    previewWrap.className = 'pm-create-avatar-thumb';
    const previewImg = document.createElement('img');
    previewImg.src = defaultAvatarSrc;
    previewImg.alt = '';
    previewImg.onerror = function () { this.onerror = null; this.src = FALLBACK_AVATAR_URL; };
    previewWrap.appendChild(previewImg);

    const metaWrap = document.createElement('div');
    metaWrap.className = 'pm-create-avatar-meta';
    const rowLabel = document.createElement('span');
    rowLabel.className = 'pm-create-avatar-label';
    rowLabel.textContent = t('create.avatarLabel');
    const rowState = document.createElement('span');
    rowState.className = 'pm-create-avatar-state';
    rowState.textContent = t('create.avatarDefault');
    metaWrap.append(rowLabel, rowState);

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'pm-create-avatar-actions';
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'menu_button interactable pm-create-avatar-pick';
    pickBtn.textContent = t('create.avatarPick');
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'menu_button menu_button_icon interactable pm-create-avatar-reset';
    resetBtn.title = t('create.avatarReset');
    resetBtn.setAttribute('aria-label', t('create.avatarReset'));
    resetBtn.hidden = true;
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    actionsWrap.append(pickBtn, resetBtn, fileInput);
    avatarRow.append(previewWrap, metaWrap, actionsWrap);
    popup.inputControls?.appendChild(avatarRow);

    pickBtn.addEventListener('click', () => {
        if (!pickingImage) fileInput.click();
    });
    resetBtn.addEventListener('click', () => {
        pickedBlob = null;
        revokePreview();
        previewImg.src = defaultAvatarSrc;
        rowState.textContent = t('create.avatarDefault');
        resetBtn.hidden = true;
    });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file || pickingImage) return;
        pickingImage = true;
        pickBtn.disabled = true;
        try {
            const blob = await prepareAvatarUploadBlob(file);
            if (!blob || !popup.dlg?.isConnected) return;
            pickedBlob = blob;
            revokePreview();
            previewUrl = URL.createObjectURL(blob);
            previewImg.src = previewUrl;
            rowState.textContent = file.name || t('create.avatarPick');
            resetBtn.hidden = false;
        } catch (err) {
            warn('create-avatar', err);
            toastr.error(t('editor.imageError'));
        } finally {
            pickingImage = false;
            pickBtn.disabled = false;
            if (popup.dlg?.open) pickBtn.focus({ preventScroll: true });
        }
    });

    let name;
    try {
        name = await popup.show();
    } finally {
        revokePreview();
    }
    if (!name || typeof name !== 'string' || !name.trim() || !state.isOpen || generation !== state.openGeneration) return;
    const trimmedName = name.trim();
    const title = String(popup.inputResults?.get('persona_title') || '').trim();

    const newId = `${Date.now()}-${trimmedName.replace(/[^a-zA-Z0-9]/g, '')}.png`;
    try {
        state.busy = true;
        power_user.personas[newId] = trimmedName;
        power_user.persona_descriptions[newId] = {
            description: '', position: POS.IN_PROMPT, depth: DEFAULT_DEPTH, role: DEFAULT_ROLE,
            lorebook: '', title, connections: [],
        };
        const blob = pickedBlob || await (await fetch(defaultAvatarSrc)).blob();
        await uploadAvatarBlob(newId, blob);
        const s = getSettings();
        if (s.folders.some((f) => f.id === state.activeFolderId)) {
            s.assignments[newId] = state.activeFolderId;
        }
        saveSettings();
        ctx.saveSettingsDebounced();
        await eventSource.emit(event_types.PERSONA_CREATED, { avatarId: newId, name: trimmedName, description: '', title });
        if (state.isOpen && generation === state.openGeneration && state.editorId === editorId) openEditor(newId);
    } catch (err) {
        warn('create', err);
        delete power_user.personas[newId];
        delete power_user.persona_descriptions[newId];
        toastr.error(t('create.error'));
    } finally {
        state.busy = false;
    }
}

// ── Convert character → persona ───────────────────────────────────────────
/**
 * Pick a character from a CONFIRM-popup dropdown and convert it to a persona
 * via the exported convertCharacterToPersona(index) (handles overwrite + macro
 * prompts, avatar upload, PERSONA_CREATED). Groups are excluded.
 */
async function onConvert() {
    if (state.busy) return;
    const ctx = getContext();
    const chars = Array.isArray(ctx.characters) ? ctx.characters : [];
    if (!chars.length) { toastr.info(t('convert.empty')); return; }

    const container = document.createElement('div');
    const label = document.createElement('label');
    label.style.display = 'block';
    label.style.marginBottom = '6px';
    label.textContent = t('convert.prompt');
    const select = document.createElement('select');
    select.className = 'text_pole';
    select.style.width = '100%';
    // Keep original indices (convertCharacterToPersona expects the array index).
    chars
        .map((c, i) => ({ i, name: c?.name || `#${i}` }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((c) => select.appendChild(new Option(c.name, String(c.i))));
    container.append(label, select);

    const Popup = ctx.Popup;
    const instance = new Popup(container, ctx.POPUP_TYPE?.CONFIRM ?? 2, '', {
        okButton: t('convert.btn'),
        cancelButton: t('select.cancel'),
    });
    stylePopupDialog(instance.dlg);
    const result = await instance.show();
    const affirmative = ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1;
    if (result !== affirmative && result !== true) return;

    const index = Number(select.value);
    if (!Number.isInteger(index) || index < 0 || index >= chars.length) return;

    try {
        // convertCharacterToPersona emits PERSONA_CREATED, which reloads the list.
        await convertCharacterToPersona(index);
    } catch (err) {
        warn('convert', err);
        toastr.error(t('convert.error'));
    }
}

// ── Per-card actions ──────────────────────────────────────────────────────
function onCardAction(action, avatarId) {
    if (action === 'edit') openEditor(avatarId);
}

// ── Editor (master-detail, 3rd column) ────────────────────────────────────
/** Get-or-create the full descriptor object for a persona id. */
function getDescriptor(avatarId) {
    let obj = power_user.persona_descriptions[avatarId];
    if (!obj) {
        obj = { description: '', position: POS.IN_PROMPT, depth: DEFAULT_DEPTH, role: DEFAULT_ROLE, lorebook: '', title: '', connections: [] };
        power_user.persona_descriptions[avatarId] = obj;
    }
    if (!Array.isArray(obj.connections)) obj.connections = [];
    return obj;
}

/** Keep the active prompt and native persona controls in sync. */
function syncActiveMirror(avatarId, obj) {
    if (avatarId !== user_avatar) return;
    power_user.persona_description = obj.description ?? '';
    power_user.persona_description_position = obj.position ?? POS.IN_PROMPT;
    power_user.persona_description_depth = obj.depth ?? DEFAULT_DEPTH;
    power_user.persona_description_role = obj.role ?? DEFAULT_ROLE;
    power_user.persona_description_lorebook = obj.lorebook ?? '';
    setPersonaDescription();
}

/** Persist a descriptor edit and notify ST (without clobbering our own inputs). */
async function commitDescriptor(avatarId, obj) {
    if (avatarId !== state.editorId || !state.editorCommitted || !power_user.personas?.[avatarId]) return;
    const previous = state.editorCommitted;
    if (Object.keys(obj).every((key) => obj[key] === previous[key])) {
        if (!state.savePending) setSaveStatus(state.saveStatus ? 'editor.autosave' : '');
        return;
    }
    state.editorCommitted = { ...obj };
    syncActiveMirror(avatarId, obj);
    saveSettings();

    if (state.isOpen) {
        const meta = personaMeta(avatarId);
        const term = state.search.trim().toLowerCase();
        const matches = (desc) => [meta.name, desc.title || '', desc.description || ''].some((value) => value.toLowerCase().includes(term));
        if (term && matches(previous) !== matches(obj)) {
            renderGrid();
        } else if (previous.title !== obj.title) {
            const card = state.dom.grid?.querySelector(`.pm_card[data-avatar-id="${CSS.escape(avatarId)}"]`);
            if (card) {
                card.title = meta.title ? `${meta.name} — ${meta.title}` : meta.name;
                const title = card.querySelector('.pm_card_title');
                title.textContent = meta.title;
                title.hidden = !meta.title;
            }
        }
        if (avatarId === user_avatar && previous.title !== obj.title) {
            const title = state.dom.spotlight?.querySelector('.pm_spotlight_title');
            if (title) {
                title.textContent = title.title = meta.title;
                title.hidden = !meta.title;
            }
        }
    }
    await eventSource.emit(event_types.PERSONA_UPDATED, avatarId, EDITOR_UPDATE);
}

function openEditor(avatarId) {
    state.commitEditorEdits?.();
    flushSave();
    state.editorId = avatarId;
    state.editorCommitted = { ...getDescriptor(avatarId) };
    state.editorOpener = state.dom.editor?.contains(document.activeElement) ? null : document.activeElement;
    state.dom.content?.classList.add('pm-editing');
    state.dom.editor?.classList.remove('pm_hidden');
    setEditorMaximized(isMobileLayout());
    renderEditor();
    state.dom.editorClose?.focus({ preventScroll: true });
}

function closeEditor({ commit = true } = {}) {
    // Capture fullscreen-editor writeback before clearing pending field timers.
    const id = state.editorId;
    const restoreFocus = state.dom.editor?.contains(document.activeElement);
    if (commit && id && state.dom.fDesc && power_user.personas?.[id]) {
        const obj = getDescriptor(id);
        if (obj.description !== state.dom.fDesc.value) {
            obj.description = state.dom.fDesc.value;
            commitDescriptor(id, obj);
        }
    }
    state.commitEditorEdits?.(commit);
    if (commit) flushSave();
    state.editorId = null;
    state.editorCommitted = null;
    setEditorMaximized(false);
    state.dom.content?.classList.remove('pm-editing');
    state.dom.editor?.classList.add('pm_hidden');
    if (restoreFocus) {
        const card = id && state.dom.grid?.querySelector(`.pm_card[data-avatar-id="${CSS.escape(id)}"]`);
        const opener = state.editorOpener?.isConnected ? state.editorOpener : null;
        (opener || card?.querySelector('[data-pm-card="edit"]') || state.dom.modal)?.focus({ preventScroll: true });
    }
    state.editorOpener = null;
}

/**
 * Expand the persona editor to a true viewport workspace. This remains separate
 * from CodeMirror Pro, which owns its description-editor dialog independently.
 */
function setEditorMaximized(on) {
    state.editorMaximized = on;
    state.dom.modal?.classList.toggle('pm-editor-max', on);
    const btn = state.dom.editorExpand;
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) icon.className = on ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        btn.classList.toggle('is-on', on);
        const label = t(on ? 'editor.collapse' : 'editor.expand');
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', String(on));
    }
}

async function updateTokenCount(text) {
    const id = state.editorId;
    if (!id || !state.dom.tokenNum || state.dom.fDesc?.value !== text) return;
    state.dom.tokenNum.textContent = '-';
    let count = text ? '-' : 0;
    try {
        const fn = getContext().getTokenCountAsync;
        if (text && typeof fn === 'function') {
            const result = await fn(text);
            if (Number.isFinite(result) && result >= 0) count = result;
        }
    } catch (_) { /* ignore */ }
    if (state.editorId !== id || state.dom.fDesc?.value !== text) return;
    state.dom.tokenNum.textContent = String(count);
}

function renderConnectionList(obj) {
    const el = state.dom.connList;
    if (!el) return;
    const ctx = getContext();
    const chars = ctx.characters || [];
    const groups = ctx.groups || [];
    const conns = Array.isArray(obj.connections) ? obj.connections : [];
    const items = [];
    for (const c of conns) {
        if (c.type === 'character') {
            const ch = chars.find((x) => x.avatar === c.id);
            if (ch) items.push({ name: ch.name, img: ctx.getThumbnailUrl ? ctx.getThumbnailUrl('avatar', ch.avatar) : '' });
        } else if (c.type === 'group') {
            const g = groups.find((x) => String(x.id) === String(c.id));
            if (g) items.push({ name: g.name, img: '' });
        }
    }
    if (!items.length) {
        el.innerHTML = `<span class="pm_conn_empty">${escapeHtml(t('editor.noConnections'))}</span>`;
        return;
    }
    el.innerHTML = items.map((i) => `
        <span class="pm_conn_avatar" title="${escapeHtml(i.name)}">
            ${i.img ? `<img src="${escapeHtml(i.img)}" alt="${escapeHtml(i.name)}" onerror="this.style.display='none';" />` : `<i class="fa-solid fa-user-group"></i>`}
        </span>`).join('');
}

function renderEditorFolderSelect(avatarId = state.editorId) {
    const sel = state.dom.fFolder;
    if (!sel || !avatarId) return;
    const s = getSettings();
    sel.innerHTML = '';
    sel.appendChild(new Option(t('folder.unfiled'), FOLDER_UNFILED));
    [...s.folders]
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        .forEach((f) => sel.appendChild(new Option(f.name, f.id)));
    const assigned = s.assignments[avatarId];
    sel.value = assigned && s.folders.some((f) => f.id === assigned) ? assigned : FOLDER_UNFILED;
}

function renderEditor() {
    const id = state.editorId;
    if (!id || !state.dom.editor) return;
    state.commitEditorEdits?.();
    const meta = personaMeta(id);
    const obj = getDescriptor(id);
    state.editorCommitted = { ...obj };
    const isActive = id === user_avatar;

    state.dom.editorImg.src = personaImageUrl(id);
    state.dom.editorImg.onerror = function () { this.onerror = null; this.src = FALLBACK_AVATAR_URL; };
    state.dom.editorName.textContent = meta.name;
    state.dom.editorRename?.setAttribute('aria-label', `${t('editor.rename')}: ${meta.name}`);
    state.dom.editorSubtitle.textContent = meta.title || '';
    state.dom.editorSubtitle.hidden = !meta.title;

    if (state.dom.editorUse) {
        state.dom.editorUse.classList.toggle('is-active', isActive);
        state.dom.editorUse.setAttribute('aria-pressed', String(isActive));
        const icon = state.dom.editorUse.querySelector('i');
        if (icon) icon.className = isActive ? 'fa-solid fa-circle-check' : 'fa-solid fa-check';
    }
    if (state.dom.editorUseLabel) {
        state.dom.editorUseLabel.textContent = t(isActive ? 'editor.active' : 'editor.use');
    }

    state.dom.fTitle.value = meta.title || '';
    state.dom.fDesc.value = obj.description || '';
    state.dom.fPosition.value = String(obj.position ?? POS.IN_PROMPT);
    state.dom.fDepth.value = obj.depth ?? DEFAULT_DEPTH;
    state.dom.fRole.value = String(obj.role ?? DEFAULT_ROLE);
    state.dom.depthWrap.classList.toggle('pm_hidden', Number(obj.position) !== POS.AT_DEPTH);
    state.dom.fNotes.value = getSettings().notes?.[id] || '';

    const sel = state.dom.fLorebook;
    sel.innerHTML = '';
    sel.appendChild(new Option(t('editor.lorebook.none'), ''));
    for (const w of (world_names || [])) sel.appendChild(new Option(w, w));
    sel.value = obj.lorebook || '';

    renderEditorFolderSelect(id);

    // Default applies to the edited persona; chat/character locks require active persona.
    state.dom.connHint.classList.toggle('pm_hidden', isActive);
    state.dom.connLocks.querySelectorAll('[data-pm-lock]').forEach((btn) => {
        const type = btn.getAttribute('data-pm-lock');
        const isDefaultLock = type === 'default';
        const enabled = isDefaultLock || isActive;
        const on = isDefaultLock ? power_user.default_persona === id : (isActive && isPersonaLocked(type));
        btn.disabled = !enabled;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', String(on));
    });

    renderConnectionList(obj);
    updateTokenCount(obj.description || '');
    setSaveStatus(state.saveStatus);
}

async function onEditorImagePicked(file) {
    const id = state.editorId;
    if (!id || !file || state.busy) return;
    const generation = state.openGeneration;
    try {
        const blob = await prepareAvatarUploadBlob(file);
        if (!blob || !state.isOpen || generation !== state.openGeneration || !power_user.personas?.[id]) return;
        const uploadedId = await uploadAvatarBlob(id, blob);
        const fullUrl = `/${getUserAvatar(uploadedId).split('/').map(encodeURIComponent).join('/')}`;
        await Promise.allSettled([
            fetch(fullUrl, { cache: 'reload' }),
            fetch(getThumbnailUrl('persona', uploadedId), { cache: 'reload' }),
        ]);
        state.imageRevisions.set(id, Date.now());
        refreshVisibleAvatarImages(id);
    } catch (err) {
        warn('avatar', err);
        toastr.error(t('editor.imageError'));
    }
}

function refreshVisibleAvatarImages(avatarId) {
    const nextUrl = personaImageUrl(avatarId);
    const escapedId = CSS.escape(avatarId);
    const images = new Set(state.dom.modal?.querySelectorAll(`.pm_card[data-avatar-id="${escapedId}"] img`) || []);
    if (state.editorId === avatarId && state.dom.editorImg) images.add(state.dom.editorImg);
    if (user_avatar === avatarId) {
        state.dom.spotlight?.querySelectorAll('img').forEach((img) => images.add(img));
        document.querySelectorAll('.mes[is_user="true"][force_avatar="false"] .avatar img').forEach((img) => images.add(img));
    }
    document.querySelectorAll(`#user_avatar_block .avatar[data-avatar-id="${escapedId}"] img`).forEach((img) => images.add(img));
    images.forEach((img) => { img.src = nextUrl; });
}

async function onEditorDuplicate() {
    const id = state.editorId;
    if (!id || state.busy) return;
    const generation = state.openGeneration;
    const ctx = getContext();
    const name = power_user.personas[id] || '';
    const ok = await ctx.Popup.show.confirm(t('editor.duplicate'), t('editor.duplicateConfirm', { name }));
    if (!ok || !state.isOpen || generation !== state.openGeneration || state.editorId !== id) return;
    const newId = `${Date.now()}-${name.replace(/[^a-zA-Z0-9]/g, '')}.png`;
    const src = getDescriptor(id);
    try {
        power_user.personas[newId] = name;
        power_user.persona_descriptions[newId] = {
            description: src.description ?? '',
            position: src.position ?? POS.IN_PROMPT,
            depth: src.depth ?? DEFAULT_DEPTH,
            role: src.role ?? DEFAULT_ROLE,
            lorebook: src.lorebook ?? '',
            title: src.title ?? '',
            connections: [],
        };
        const blob = await (await fetch(`/${getUserAvatar(id).split('/').map(encodeURIComponent).join('/')}`)).blob();
        await uploadAvatarBlob(newId, blob);
        const s = getSettings();
        if (s.assignments[id]) s.assignments[newId] = s.assignments[id];
        saveSettings();
        ctx.saveSettingsDebounced();
        await eventSource.emit(event_types.PERSONA_CREATED, { avatarId: newId, name, description: src.description ?? '', title: src.title ?? '' });
        if (state.isOpen && generation === state.openGeneration && state.editorId === id) openEditor(newId);
    } catch (err) {
        warn('duplicate', err);
        delete power_user.personas[newId];
        delete power_user.persona_descriptions[newId];
        toastr.error(t('editor.duplicateError'));
    }
}

async function onEditorRename() {
    const id = state.editorId;
    if (!id) return;
    const generation = state.openGeneration;
    const ctx = getContext();
    const current = power_user.personas[id] || '';
    const name = await ctx.Popup.show.input(t('editor.rename'), t('editor.renamePrompt'), current);
    if (!state.isOpen || generation !== state.openGeneration || state.editorId !== id) return;
    if (!name || !name.trim() || name === current) return;
    power_user.personas[id] = name.trim();
    if (id === user_avatar) setUserName(name.trim());
    saveSettings();
    await eventSource.emit(event_types.PERSONA_RENAMED, { avatarId: id, oldName: current, newName: name.trim() });
}

async function onEditorSetDefault() {
    const id = state.editorId;
    if (!id) return;
    power_user.default_persona = power_user.default_persona === id ? null : id;
    saveSettings();
    await eventSource.emit(event_types.PERSONA_UPDATED, id);
}

async function onEditorDelete() {
    const id = state.editorId;
    if (!id) return;
    const ctx = getContext();
    const name = power_user.personas?.[id] || '';
    const ok = await ctx.Popup.show.confirm(t('card.delete'), t('card.deleteConfirm', { name }));
    if (!ok) return;
    closeEditor({ commit: false });
    if (!(await deletePersonaViaNative(id))) {
        toastr.error(t('card.deleteError'));
        openEditor(id);
        return;
    }
}

/** Wire editor field + action listeners (called once when the DOM is built). */
function bindEditorEvents() {
    const d = state.dom;
    if (!d.editor) return;
    let titleTimer = null;
    let tokenTimer = null;
    let descTimer = null;
    state.commitEditorEdits = (commit = true) => {
        clearTimeout(titleTimer);
        clearTimeout(descTimer);
        clearTimeout(tokenTimer);
        if (commit && state.editorId && power_user.personas?.[state.editorId]) {
            commitDescriptor(state.editorId, getDescriptor(state.editorId));
        }
    };

    d.editorClose?.addEventListener('click', closeEditor);
    d.editorBack?.addEventListener('click', closeEditor);
    d.editorExpand?.addEventListener('click', () => setEditorMaximized(!state.editorMaximized));
    d.editorAvatarBtn?.addEventListener('click', () => {
        if (!state.busy) d.imageInput?.click();
    });
    d.editorRename?.addEventListener('click', onEditorRename);
    d.editorUse?.addEventListener('click', () => {
        if (state.editorId) selectPersona(state.editorId);
    });

    d.fTitle?.addEventListener('input', () => {
        const id = state.editorId; if (!id) return;
        const obj = getDescriptor(id);
        if (obj.title === d.fTitle.value) return;
        obj.title = d.fTitle.value;
        d.editorSubtitle.textContent = obj.title;
        d.editorSubtitle.hidden = !obj.title;
        setSaveStatus('editor.saving');
        clearTimeout(titleTimer);
        titleTimer = setTimeout(() => commitDescriptor(id, obj), 250);
    });
    d.fTitle?.addEventListener('blur', () => {
        const id = state.editorId; if (!id) return;
        clearTimeout(titleTimer);
        commitDescriptor(id, getDescriptor(id));
        flushSave();
    });

    // Description uses a jQuery `input` binding (NOT addEventListener): ST's
    // full-screen editor writes back via jQuery `.trigger('input')`, which native
    // listeners never receive. jQuery handlers catch both real input and triggers.
    if (d.fDesc) {
        $(d.fDesc).on('input', () => {
            const id = state.editorId; if (!id) return;
            const obj = getDescriptor(id);
            if (obj.description === d.fDesc.value) return;
            obj.description = d.fDesc.value;
            setSaveStatus('editor.saving');
            d.tokenNum.textContent = '-';
            clearTimeout(tokenTimer);
            tokenTimer = setTimeout(() => updateTokenCount(obj.description), 180);
            clearTimeout(descTimer);
            descTimer = setTimeout(() => commitDescriptor(id, obj), 300);
        });
        // jQuery fullscreen writeback also reaches this commit path.
        $(d.fDesc).on('blur', () => {
            const id = state.editorId; if (!id) return;
            clearTimeout(descTimer);
            clearTimeout(tokenTimer);
            const obj = getDescriptor(id);
            obj.description = d.fDesc.value;
            updateTokenCount(obj.description);
            commitDescriptor(id, obj);
            flushSave();
        });
    }

    d.fPosition?.addEventListener('change', () => {
        const id = state.editorId; if (!id) return;
        const obj = getDescriptor(id);
        obj.position = Number(d.fPosition.value);
        d.depthWrap.classList.toggle('pm_hidden', obj.position !== POS.AT_DEPTH);
        commitDescriptor(id, obj);
        flushSave();
    });

    d.fDepth?.addEventListener('input', () => {
        const id = state.editorId; if (!id) return;
        const obj = getDescriptor(id);
        obj.depth = Number(d.fDepth.value);
        commitDescriptor(id, obj);
    });
    d.fDepth?.addEventListener('blur', flushSave);

    d.fRole?.addEventListener('change', () => {
        const id = state.editorId; if (!id) return;
        const obj = getDescriptor(id);
        obj.role = Number(d.fRole.value);
        commitDescriptor(id, obj);
        flushSave();
    });

    d.fLorebook?.addEventListener('change', () => {
        const id = state.editorId; if (!id) return;
        const obj = getDescriptor(id);
        obj.lorebook = d.fLorebook.value;
        commitDescriptor(id, obj);
        flushSave();
    });

    d.loreOpen?.addEventListener('click', () => {
        const name = d.fLorebook?.value;
        if (name) openWorldInfoEditor(name);
    });

    d.fFolder?.addEventListener('change', () => {
        const id = state.editorId; if (!id) return;
        assignToFolder(id, d.fFolder.value);
        flushSave();
        renderSidebar();
        renderGrid();
    });

    d.fNotes?.addEventListener('input', () => {
        const id = state.editorId; if (!id) return;
        const s = getSettings();
        if ((s.notes[id] || '') === d.fNotes.value) return;
        if (d.fNotes.value) s.notes[id] = d.fNotes.value;
        else delete s.notes[id];
        saveSettings();
    });
    d.fNotes?.addEventListener('blur', flushSave);

    d.connLocks?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pm-lock]');
        if (!btn || btn.disabled) return;
        e.stopPropagation();
        const type = btn.getAttribute('data-pm-lock');
        if (type === 'default') onEditorSetDefault();
        else toggleLock(type);
    });

    d.opDuplicate?.addEventListener('click', onEditorDuplicate);
    d.opDelete?.addEventListener('click', onEditorDelete);
    d.imageInput?.addEventListener('change', () => {
        const file = d.imageInput.files?.[0];
        d.imageInput.value = '';
        if (file) onEditorImagePicked(file);
    });
}

// ── Selection / bulk actions ──────────────────────────────────────────────
function setSelectMode(on) {
    const restoreFocus = !on && state.dom.selectBar?.contains(document.activeElement);
    state.selectMode = on;
    if (!on) state.selected.clear();
    state.dom.modal.classList.toggle('pm_selecting', on);
    renderGrid();
    if (restoreFocus) state.dom.selectToggle?.focus({ preventScroll: true });
}

function toggleSelection(avatarId) {
    if (state.selected.has(avatarId)) state.selected.delete(avatarId);
    else state.selected.add(avatarId);
    updateSelectUI();
    const card = state.dom.grid.querySelector(`.pm_card[data-avatar-id="${CSS.escape(avatarId)}"]`);
    if (card) {
        card.classList.toggle('is-selected', state.selected.has(avatarId));
        card.querySelector('.pm_card_pick')?.setAttribute('aria-pressed', String(state.selected.has(avatarId)));
        const icon = card.querySelector('.pm_card_check i');
        if (icon) icon.className = state.selected.has(avatarId) ? 'fa-solid fa-square-check' : 'fa-regular fa-square';
    }
}

function updateSelectUI() {
    const count = state.selected.size;
    state.dom.selectBar?.classList.toggle('pm_hidden', !state.selectMode);
    state.dom.selectToggle?.setAttribute('aria-pressed', String(state.selectMode));
    for (const key of ['bulkMove', 'bulkFav', 'bulkExport', 'bulkDelete']) {
        if (state.dom[key]) state.dom[key].disabled = count === 0;
    }
    if (state.dom.selectCount) state.dom.selectCount.textContent = t('select.count', { n: count });
}

function selectAllVisible() {
    const all = getVisiblePersonas();
    const start = (state.currentPage - 1) * state.pageSize;
    for (const p of all.slice(start, start + state.pageSize)) state.selected.add(p.id);
    renderGrid();
}

async function bulkDelete() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const generation = state.openGeneration;
    const ctx = getContext();
    const ok = await ctx.Popup.show.confirm(t('select.delete'), t('select.deleteConfirm', { n: ids.length }));
    if (!ok || !state.isOpen || generation !== state.openGeneration) return;
    const failed = [];
    state.suppressPersonaReload = true;
    try {
        for (const id of ids) {
            if (!(await deletePersonaViaNative(id))) failed.push(id);
        }
    } finally {
        state.suppressPersonaReload = false;
    }
    if (state.isOpen && generation === state.openGeneration) {
        state.selected = new Set(failed);
        if (!failed.length) setSelectMode(false);
    }
    if (failed.length) toastr.error(t('card.deleteError'));
    await refresh();
}

async function bulkMove() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const generation = state.openGeneration;
    const folderId = await pickFolder();
    if (folderId === undefined || !state.isOpen || generation !== state.openGeneration) return;
    for (const id of ids) assignToFolder(id, folderId);
    setSelectMode(false);
    renderSidebar();
    if (state.editorId) renderEditorFolderSelect(state.editorId);
}

function bulkFavorite() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const allFav = ids.every(isFavorite);
    for (const id of ids) {
        if (allFav && isFavorite(id)) toggleFavorite(id);
        else if (!allFav && !isFavorite(id)) toggleFavorite(id);
    }
    setSelectMode(false);
    renderSidebar();
}

async function bulkExport() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const generation = state.openGeneration;
    await exportPersonasZip(ids, `personas-selection-${backupStamp()}.zip`);
    if (state.isOpen && generation === state.openGeneration) setSelectMode(false);
}

/**
 * Folder picker — a select dropdown inside a CONFIRM popup (background-manager
 * pattern). Returns the chosen folder id, FOLDER_UNFILED, or undefined if
 * cancelled.
 */
async function pickFolder() {
    const ctx = getContext();
    const Popup = ctx.Popup;
    const POPUP_TYPE = ctx.POPUP_TYPE;

    const container = document.createElement('div');
    const label = document.createElement('label');
    label.style.display = 'block';
    label.style.marginBottom = '6px';
    label.textContent = t('folder.pickPrompt');
    const select = document.createElement('select');
    select.className = 'text_pole';
    select.setAttribute('aria-label', t('folder.pickPrompt'));
    select.style.width = '100%';
    select.appendChild(new Option(t('folder.unfiled'), FOLDER_UNFILED));
    getSettings().folders
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((f) => select.appendChild(new Option(f.name, f.id)));
    container.append(label, select);

    const instance = new Popup(container, POPUP_TYPE?.CONFIRM ?? 2, '', {
        okButton: t('select.move'),
        cancelButton: t('select.cancel'),
    });
    stylePopupDialog(instance.dlg);
    const result = await instance.show();
    const affirmative = ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1;
    if (result !== affirmative && result !== true) return undefined;
    return select.value;
}

async function onNewFolder() {
    const ctx = getContext();
    const name = await ctx.Popup.show.input(t('folder.new'), t('folder.namePrompt'), '');
    if (!name || !name.trim()) return;
    const folder = createFolder(name);
    state.activeFolderId = folder.id;
    state.currentPage = 1;
    if (!isMobileLayout()) state.sidebarPreference = true;
    applyFolderLayout();
    if (isMobileLayout()) setSidebarOpen(false);
    renderSidebar();
    if (state.editorId) renderEditorFolderSelect(state.editorId);
    renderGrid({ resetScroll: true });
}

async function onRenameFolder(folderId) {
    const ctx = getContext();
    const folder = getSettings().folders.find((f) => f.id === folderId);
    if (!folder) return;
    const name = await ctx.Popup.show.input(t('folder.rename'), t('folder.namePrompt'), folder.name);
    if (!name || !name.trim()) return;
    renameFolder(folderId, name);
    renderSidebar();
    if (state.editorId) renderEditorFolderSelect(state.editorId);
}

async function onDeleteFolder(folderId) {
    const ctx = getContext();
    const folder = getSettings().folders.find((f) => f.id === folderId);
    if (!folder) return;
    const ok = await ctx.Popup.show.confirm(t('folder.delete'), t('folder.deleteConfirm', { name: folder.name }));
    if (!ok) return;
    deleteFolder(folderId);
    applyFolderLayout();
    renderSidebar();
    if (state.editorId) renderEditorFolderSelect(state.editorId);
    renderGrid();
}

// ── Drag & drop (assign personas to folders) ──────────────────────────────
function bindDragAndDrop() {
    const { grid, sidebar } = state.dom;
    if (!grid || !sidebar) return;

    grid.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.pm_card');
        if (!card) return;
        state.dragId = card.dataset.avatarId;
        card.classList.add('is-dragging');
        try { e.dataTransfer.setData('text/pm-avatar', state.dragId); } catch (_) { /* ignore */ }
        e.dataTransfer.effectAllowed = 'move';
    });

    grid.addEventListener('dragend', (e) => {
        e.target.closest('.pm_card')?.classList.remove('is-dragging');
        state.dragId = null;
        sidebar.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    });

    sidebar.addEventListener('dragover', (e) => {
        const row = e.target.closest('[data-folder-id]');
        if (!row || !state.dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!row.classList.contains('is-drop-target')) {
            sidebar.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
            row.classList.add('is-drop-target');
        }
    });

    sidebar.addEventListener('dragleave', (e) => {
        const row = e.target.closest('[data-folder-id]');
        if (row && !row.contains(e.relatedTarget)) row.classList.remove('is-drop-target');
    });

    sidebar.addEventListener('drop', (e) => {
        const row = e.target.closest('[data-folder-id]');
        if (!row || !state.dragId) return;
        e.preventDefault();
        const target = row.getAttribute('data-folder-id');
        if (target === FOLDER_ALL || target === FOLDER_UNFILED) {
            assignToFolder(state.dragId, FOLDER_UNFILED);
        } else {
            assignToFolder(state.dragId, target);
        }
        row.classList.remove('is-drop-target');
        state.dragId = null;
        renderSidebar();
        if (state.editorId) renderEditorFolderSelect(state.editorId);
        renderGrid();
    });
}

// ── Modal DOM ─────────────────────────────────────────────────────────────
async function ensureDom() {
    if (state.domPromise) return state.domPromise;
    if (state.dom.modal && document.body.contains(state.dom.modal)) return;
    state.domPromise = createManagerDom().finally(() => { state.domPromise = null; });
    return state.domPromise;
}

async function createManagerDom() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'manager');
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const modal = wrap.firstElementChild;
    modal.dataset.build = 'YWNlZW52dw==';
    document.body.appendChild(modal);
    i18nApplyDom(modal);

    state.dom = {
        modal,
        content: modal.querySelector('#pm_content'),
        sidebar: modal.querySelector('#pm_sidebar'),
        folderList: modal.querySelector('#pm_folder_list'),
        sidebarToggle: modal.querySelector('#pm_sidebar_toggle'),
        spotlight: modal.querySelector('#pm_spotlight'),
        search: modal.querySelector('#pm_search'),
        sort: modal.querySelector('#pm_sort'),
        filters: modal.querySelector('#pm_filters'),
        newFolder: modal.querySelector('#pm_new_folder'),
        selectToggle: modal.querySelector('#pm_select_toggle'),
        selectBar: modal.querySelector('#pm_select_bar'),
        selectCount: modal.querySelector('#pm_select_count'),
        selectAll: modal.querySelector('#pm_select_all'),
        selectCancel: modal.querySelector('#pm_select_cancel'),
        bulkMove: modal.querySelector('#pm_bulk_move'),
        bulkFav: modal.querySelector('#pm_bulk_fav'),
        bulkExport: modal.querySelector('#pm_bulk_export'),
        bulkDelete: modal.querySelector('#pm_bulk_delete'),
        grid: modal.querySelector('#pm_grid'),
        empty: modal.querySelector('#pm_empty'),
        pager: modal.querySelector('#pm_pager'),
        pagerPrev: modal.querySelector('#pm_pager_prev'),
        pagerNext: modal.querySelector('#pm_pager_next'),
        pagerLabel: modal.querySelector('#pm_pager_label'),
        pagerRange: modal.querySelector('#pm_pager_range'),
        themeBtn: modal.querySelector('#pm_theme_btn'),
        themeMenu: modal.querySelector('#pm_theme_menu'),
        themeMenuGrid: modal.querySelector('#pm_theme_menu_grid'),
        moreBtn: modal.querySelector('#pm_more_btn'),
        moreMenu: modal.querySelector('#pm_more_menu'),
        backup: modal.querySelector('#pm_backup'),
        restore: modal.querySelector('#pm_restore'),
        restoreInput: modal.querySelector('#pm_restore_input'),
        convert: modal.querySelector('#pm_convert'),
        create: modal.querySelector('#pm_create'),
        progress: modal.querySelector('#pm_progress'),
        progressArc: modal.querySelector('#pm_progress_arc'),
        progressPct: modal.querySelector('#pm_progress_pct'),
        progressLabel: modal.querySelector('#pm_progress_label'),
        editor: modal.querySelector('#pm_editor'),
        editorAvatarBtn: modal.querySelector('#pm_editor_avatar_btn'),
        editorImg: modal.querySelector('#pm_editor_img'),
        editorRename: modal.querySelector('#pm_editor_rename'),
        editorName: modal.querySelector('#pm_editor_name'),
        editorSubtitle: modal.querySelector('#pm_editor_subtitle'),
        editorUse: modal.querySelector('#pm_editor_use'),
        editorUseLabel: modal.querySelector('#pm_editor_use_label'),
        editorBack: modal.querySelector('#pm_editor_back'),
        editorExpand: modal.querySelector('#pm_editor_expand'),
        editorClose: modal.querySelector('#pm_editor_close'),
        fTitle: modal.querySelector('#pm_field_title'),
        fDesc: modal.querySelector('#pm_field_desc'),
        fPosition: modal.querySelector('#pm_field_position'),
        depthWrap: modal.querySelector('#pm_depth_wrap'),
        fDepth: modal.querySelector('#pm_field_depth'),
        fRole: modal.querySelector('#pm_field_role'),
        fLorebook: modal.querySelector('#pm_field_lorebook'),
        fFolder: modal.querySelector('#pm_field_folder'),
        fNotes: modal.querySelector('#pm_field_notes'),
        loreOpen: modal.querySelector('#pm_lore_open'),
        tokenNum: modal.querySelector('#pm_token_num'),
        saveStatus: modal.querySelector('#pm_save_status'),
        connLocks: modal.querySelector('#pm_conn_locks'),
        connHint: modal.querySelector('#pm_conn_hint'),
        connList: modal.querySelector('#pm_conn_list'),
        opDuplicate: modal.querySelector('#pm_op_duplicate'),
        opDelete: modal.querySelector('#pm_op_delete'),
        imageInput: modal.querySelector('#pm_image_input'),
    };

    applyTheme();
    bindModalEvents();
    bindEditorEvents();
}

function bindModalEvents() {
    const { modal, dom } = { modal: state.dom.modal, dom: state.dom };
    if (!modal) return;

    modal.addEventListener('click', (e) => {
        // Any click outside open popovers or the mobile folder overlay closes them.
        if (isThemeMenuOpen() && !e.target.closest('#pm_theme_btn')) closeThemeMenu();
        if (isMoreMenuOpen() && !e.target.closest('.pm_more_wrap')) closeMoreMenu();
        if (isMobileLayout() && isSidebarOpen() && !e.target.closest('#pm_sidebar, #pm_sidebar_toggle')) {
            setSidebarOpen(false);
        }

        const action = e.target.closest('[data-pm-action]')?.getAttribute('data-pm-action');
        if (action === 'close') { if (!state.busy) closeManager(); return; }
        if (action === 'edit-current') { if (user_avatar) openEditor(user_avatar); return; }

        const lockBtn = e.target.closest('[data-pm-lock]:not(.pm_conn_btn)');
        if (lockBtn) { toggleLock(lockBtn.getAttribute('data-pm-lock')); return; }

        const favBtn = e.target.closest('[data-pm-fav]');
        if (favBtn) {
            e.stopPropagation();
            toggleFavorite(favBtn.getAttribute('data-pm-fav'));
            renderSidebar();
            renderGrid();
            return;
        }

        const folderRename = e.target.closest('[data-folder-rename]');
        if (folderRename) {
            e.stopPropagation();
            onRenameFolder(folderRename.getAttribute('data-folder-rename'));
            return;
        }

        const folderDel = e.target.closest('[data-folder-del]');
        if (folderDel) {
            e.stopPropagation();
            onDeleteFolder(folderDel.getAttribute('data-folder-del'));
            return;
        }

        const folderRow = e.target.closest('[data-folder-id]');
        if (folderRow) {
            state.activeFolderId = folderRow.getAttribute('data-folder-id');
            state.currentPage = 1;
            renderSidebar();
            renderGrid({ resetScroll: true });
            if (isMobileLayout()) setSidebarOpen(false);
            return;
        }

        const cardAction = e.target.closest('[data-pm-card]');
        if (cardAction) {
            e.stopPropagation();
            const id = cardAction.closest('.pm_card')?.dataset.avatarId;
            if (id) onCardAction(cardAction.getAttribute('data-pm-card'), id);
            return;
        }

        const card = e.target.closest('.pm_card');
        if (card?.dataset.avatarId) {
            if (state.selectMode) toggleSelection(card.dataset.avatarId);
            else selectPersona(card.dataset.avatarId);
            return;
        }
    });

    modal.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Native buttons already activate on the keyboard; ST also synthesizes Enter clicks.
        if (e.target.closest('button')) e.stopPropagation();
        const maximize = e.target.closest('.pm_desc_maximize');
        if (maximize) {
            e.preventDefault();
            e.stopPropagation();
            maximize.click();
        }
    });

    dom.newFolder?.addEventListener('click', onNewFolder);
    dom.selectToggle?.addEventListener('click', () => setSelectMode(!state.selectMode));
    dom.selectAll?.addEventListener('click', selectAllVisible);
    dom.selectCancel?.addEventListener('click', () => setSelectMode(false));
    dom.bulkMove?.addEventListener('click', bulkMove);
    dom.bulkFav?.addEventListener('click', bulkFavorite);
    dom.bulkExport?.addEventListener('click', bulkExport);
    dom.bulkDelete?.addEventListener('click', bulkDelete);

    dom.themeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMoreMenu();
        toggleThemeMenu();
    });
    dom.themeMenu?.addEventListener('click', (e) => e.stopPropagation());

    dom.moreBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeThemeMenu();
        toggleMoreMenu();
    });
    dom.moreMenu?.addEventListener('click', (e) => e.stopPropagation());

    dom.backup?.addEventListener('click', () => { closeMoreMenu(); onBackup(); });
    dom.restore?.addEventListener('click', () => { closeMoreMenu(); dom.restoreInput?.click(); });
    dom.restoreInput?.addEventListener('change', () => {
        const file = dom.restoreInput.files?.[0];
        dom.restoreInput.value = '';
        if (file) onRestoreFile(file);
    });
    dom.convert?.addEventListener('click', () => { closeMoreMenu(); onConvert(); });
    dom.create?.addEventListener('click', onCreate);

    bindDragAndDrop();

    dom.sidebarToggle?.addEventListener('click', () => {
        setSidebarOpen(!isSidebarOpen(), { remember: true });
    });

    const applySearch = () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = null;
        if (state.search === dom.search.value) return;
        state.search = dom.search.value;
        state.currentPage = 1;
        renderGrid({ resetScroll: true });
    };
    dom.search?.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(applySearch, 160);
    });
    // Enter and the native clear button should filter without waiting.
    dom.search?.addEventListener('search', applySearch);
    dom.search?.addEventListener('blur', applySearch);

    dom.sort?.addEventListener('change', () => {
        state.sort = dom.sort.value;
        getSettings().sort = state.sort;
        saveSettings();
        state.currentPage = 1;
        renderGrid({ resetScroll: true });
    });

    dom.filters?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-pm-filter]');
        if (chip) setActiveFilter(chip.dataset.pmFilter);
    });

    dom.pagerPrev?.addEventListener('click', () => { state.currentPage--; renderGrid({ resetScroll: true }); });
    dom.pagerNext?.addEventListener('click', () => { state.currentPage++; renderGrid({ resetScroll: true }); });

    document.addEventListener('keydown', onGlobalKeydown);
}

function onGlobalKeydown(e) {
    if (!state.isOpen) return;
    if (e.key === 'Tab') {
        const openDialog = document.querySelector('dialog.popup[open], dialog[open]');
        if (openDialog && !state.dom.modal?.contains(openDialog)) return;
        const focusable = [...state.dom.modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter((el) => el.offsetParent !== null && !el.closest('[inert]') && !el.closest('.pm_sidebar.is-collapsed'));
        if (!focusable.length) {
            e.preventDefault();
            state.dom.modal.focus({ preventScroll: true });
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (document.activeElement === state.dom.modal || !state.dom.modal.contains(document.activeElement)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
        return;
    }
    if (e.key !== 'Escape') return;
    // Let an open popup/dialog (e.g. CodeMirror Pro's editor) handle Escape first.
    if (document.querySelector('dialog.popup[open], dialog[open]')) return;
    e.preventDefault();
    if (state.busy) return; // backup/restore in progress
    if (isThemeMenuOpen()) { closeThemeMenu(); return; }
    if (isMoreMenuOpen()) { closeMoreMenu(); return; }
    if (isMobileLayout() && isSidebarOpen()) { setSidebarOpen(false); return; }
    if (state.editorId && isMobileLayout()) { closeEditor(); return; }
    if (state.editorMaximized) { setEditorMaximized(false); return; }
    if (state.editorId) { closeEditor(); return; }
    closeManager();
}

async function openManager() {
    if (state.isOpen) return;
    const generation = ++state.openGeneration;
    if (!state.lastFocusedElement) {
        state.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    await ensureDom();
    if (generation !== state.openGeneration) return;
    const s = getSettings();
    state.isOpen = true;
    state.sort = s.sort || 'az';
    state.pageSize = Number(s.pageSize) || DEFAULT_SETTINGS.pageSize;
    state.currentPage = 1;
    state.dom.sort.value = state.sort;
    state.dom.search.value = state.search;
    applyTheme();
    state.dom.modal.classList.remove('pm_hidden');
    collapseNativePersonaDrawer();
    state.dom.modal.focus({ preventScroll: true });
    if (!(await refresh())) return;
    if (!state.isOpen || generation !== state.openGeneration) return;
    state.dom.grid.scrollTop = 0;
}

function closeManager() {
    state.openGeneration++;
    state.isOpen = false;
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.selected.clear();
    state.selectMode = false;
    if (state.dom.modal) {
        closeThemeMenu();
        closeMoreMenu();
        if (isMobileLayout()) setSidebarOpen(false);
        closeEditor();
        state.dom.modal.classList.remove('pm_selecting');
        updateSelectUI();
        state.dom.modal.classList.add('pm_hidden');
    }
    if (state.lastFocusedElement?.isConnected) state.lastFocusedElement.focus({ preventScroll: true });
    state.lastFocusedElement = null;
}

function collapseNativePersonaDrawer() {
    const drawer = document.getElementById('PersonaManagement');
    if (drawer && drawer.classList.contains('openDrawer')) {
        state.suppressDrawerHijack = true;
        document.querySelector('#persona-management-button .drawer-toggle')?.click();
        state.suppressDrawerHijack = false;
    }
}

// ── Drawer hijack ─────────────────────────────────────────────────────────
function hijackPersonaDrawer() {
    if (!getSettings().hijackDrawer) return;

    const drawerButton = document.querySelector('#persona-management-button .drawer-toggle');
    if (drawerButton && !drawerButton.dataset.pmHijacked) {
        drawerButton.dataset.pmHijacked = 'true';
        drawerButton.addEventListener('click', (e) => {
            if (!getSettings().hijackDrawer) return;
            if (state.suppressDrawerHijack) return; // synthetic collapse click
            e.stopImmediatePropagation();
            e.preventDefault();
            if (state.isOpen) closeManager();
            else openManager();
        }, true);
    }
}

function startDrawerHijack(attempt = 0) {
    const button = document.querySelector('#persona-management-button .drawer-toggle');
    if (button) {
        hijackPersonaDrawer();
        return;
    }
    if (attempt >= 20) return; // ~5s of bounded retries, then give up
    setTimeout(() => startDrawerHijack(attempt + 1), 250);
}

// When the manager is open and the user clicks a different top-bar drawer
// icon, close the manager so it doesn't float over the newly opened panel.
function bindTopBarCloseHandlers() {
    const topBar = document.getElementById('top-settings-holder');
    if (!topBar || topBar.dataset.pmTopBarBound) return;
    topBar.dataset.pmTopBarBound = 'true';

    topBar.addEventListener('click', (e) => {
        if (!state.isOpen) return;
        // Our own button is handled by the drawer hijack (toggles the manager).
        if (e.target.closest('#persona-management-button')) return;
        // Only react to actual top-bar drawer/menu buttons.
        if (!e.target.closest('.drawer-icon, .drawer-toggle')) return;
        closeManager();
    }, true); // capture phase, before ST opens the other drawer
}

/**
 * Safety net for abrupt reloads/navigations (especially mobile): if the editor
 * is open with an uncommitted description edit, commit it and force an immediate
 * write on tab hide / page unload. No-op when nothing is being edited.
 */
function initSaveSafetyNet() {
    const flushIfEditing = () => {
        const id = state.editorId;
        if (!id || !state.dom.fDesc) return;
        const obj = getDescriptor(id);
        if (obj.description !== state.dom.fDesc.value) {
            obj.description = state.dom.fDesc.value;
        }
        state.commitEditorEdits?.();
        flushSave();
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushIfEditing();
    });
    window.addEventListener('pagehide', flushIfEditing);
    window.addEventListener('beforeunload', flushIfEditing);
}

function wireEvents() {
    const reRender = () => {
        if (!state.isOpen || state.suppressPersonaReload) return;
        renderSpotlight();
        renderGrid();
        if (state.editorId) renderEditor();
    };
    const reload = async () => {
        if (state.suppressPersonaReload) return;
        if (!state.isOpen) {
            state.avatarLoadGeneration++;
            state.avatars = null;
            return;
        }
        await refresh();
    };
    eventSource.on(event_types.PERSONA_CHANGED, (avatarId) => {
        recordPersonaUse(avatarId || user_avatar);
        reRender();
    });
    eventSource.on(event_types.PERSONA_UPDATED, (_id, source) => {
        if (source !== EDITOR_UPDATE) reRender();
    });
    eventSource.on(event_types.PERSONA_CREATED, reload);
    eventSource.on(event_types.PERSONA_DELETED, reload);
    eventSource.on(event_types.PERSONA_RENAMED, reload);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        recordPersonaUse(user_avatar);
        reRender();
    });
}

function initResponsiveEditor() {
    MOBILE_LAYOUT_MEDIA.addEventListener('change', (event) => {
        if (event.matches) {
            setSidebarOpen(false);
            if (state.editorId) setEditorMaximized(true);
        } else if (state.isOpen) {
            applyFolderLayout();
        }
    });
}

jQuery(async () => {
    LANG = detectLang();
    getSettings();
    await injectSettingsPanel();
    startDrawerHijack();
    bindTopBarCloseHandlers();
    wireEvents();
    initResponsiveEditor();
    initSaveSafetyNet();
});
