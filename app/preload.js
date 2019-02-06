'use strict';

(function () {

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var electron = require('electron');
var path = _interopDefault(require('path'));
var fs = _interopDefault(require('fs'));
var util = _interopDefault(require('util'));
var jetpack = _interopDefault(require('fs-jetpack'));
var spellchecker = _interopDefault(require('spellchecker'));
var url = _interopDefault(require('url'));
var events = require('events');
var tmp = _interopDefault(require('tmp'));

const eApp = electron.app || electron.remote.app;

let loadedLanguage = [];

/**
 * Load singular and plural translation based on count
 * @param {string} phrase The key fore the translation string
 * @param {number} chount Count to check for singular / plural (0-1,2-n)
 * @returns {string} Translation in user language
 */
function loadTranslation(phrase = '', count) {
	const loadedLanguageTranslation = loadedLanguage[phrase];
	let translation = loadedLanguageTranslation;
	if (loadedLanguageTranslation === undefined) {
		translation = phrase;
	} else if (loadedLanguageTranslation instanceof Object) {
		translation = loadedLanguageTranslation.zero;
		if (count === 1) {
			translation = loadedLanguageTranslation.one;
		} else if (count > 1) {
			translation = loadedLanguageTranslation.multi;
		}
	}
	return translation;
}

class I18n {
	/**
     * Load users language if available, and fallback to english for any missing strings
     * @constructor
     */
	constructor() {
		const load = () => {
			let dir = path.join(__dirname, '../i18n/lang');
			if (!fs.existsSync(dir)) {
				dir = path.join(__dirname, 'i18n/lang');
			}
			const defaultLocale = path.join(dir, 'en.i18n.json');
			loadedLanguage = JSON.parse(fs.readFileSync(defaultLocale, 'utf8'));
			const locale = path.join(dir, `${ eApp.getLocale() }.i18n.json`);
			if (fs.existsSync(locale)) {
				const lang = JSON.parse(fs.readFileSync(locale, 'utf8'));
				loadedLanguage = Object.assign(loadedLanguage, lang);
			}
		};

		if (eApp.isReady()) {
			load();
			return;
		}

		eApp.once('ready', load);
	}

	/**
     * Get translation string
     * @param {string} phrase The key for the translation string
     * @param {...string|number} replacements List of replacements in template strings
     * @return {string} Translation in users language
     */
	__(phrase, ...replacements) {
		const translation = loadTranslation(phrase, 0);
		return util.format(translation, ...replacements);
	}

	/**
     * Get translation string
     * @param {string} phrase The key for the translation string
     * @param {number} count Count to check for singular / plural (0-1,2-n)
     * @param {...string|number} replacements List of replacements in template strings
     * @return {string} Translation in users language
     */
	pluralize(phrase, count, ...replacements) {
		const translation = loadTranslation(phrase, count);
		if (translation.includes('%s')) {
			return util.format(translation, ...replacements);
		}
		return translation;
	}
}

var i18n = new I18n();

const { app } = electron.remote;


class SpellCheck {
	constructor() {
		this.dictionaries = [];
		this.enabledDictionaries = [];
		this.isMultiLanguage = false;
		this.dictionariesPath = null;
	}

	async load() {
		await this.loadDictionaries();
		this.setDefaultEnabledDictionaries();
	}

	async loadDictionaries() {
		const embeddedDictionaries = spellchecker.getAvailableDictionaries();

		const directory = jetpack.cwd(app.getAppPath(), app.getAppPath().endsWith('app.asar') ? '..' : '.', 'dictionaries');
		const installedDictionaries = (await directory.findAsync({ matching: '*.{aff,dic}' }))
			.map((fileName) => path.basename(fileName, path.extname(fileName)));

		this.dictionariesPath = directory.path();
		this.dictionaries = Array.from(new Set([...embeddedDictionaries, ...installedDictionaries])).sort();
		this.isMultiLanguage = embeddedDictionaries.length > 0 && process.platform !== 'win32';
	}

	setDefaultEnabledDictionaries() {
		const selectedDictionaries = (() => {
			try {
				const enabledDictionaries = JSON.parse(localStorage.getItem('spellcheckerDictionaries'));
				return Array.isArray(enabledDictionaries) ? enabledDictionaries.map(String) : null;
			} catch (error) {
				console.error(error);
				return null;
			}
		})();

		if (selectedDictionaries) {
			this.enable(...selectedDictionaries);
			return;
		}

		const userLanguage = localStorage.getItem('userLanguage');
		if (userLanguage && this.enable(this.userLanguage)) {
			return;
		}

		const navigatorLanguage = navigator.language;
		if (this.enable(navigatorLanguage)) {
			return;
		}

		if (this.enable('en_US')) {
			return;
		}
	}

	filterDictionaries(...dictionaries) {
		return dictionaries.map((dictionary) => {
			const matches = /^(\w+?)[-_](\w+)$/.exec(dictionary);

			const dictionaries = matches ?
				[`${ matches[1] }_${ matches[2] }`, `${ matches[1] }-${ matches[2] }`, matches[1]] :
				[dictionary];

			return dictionaries.find((dictionary) => this.dictionaries.includes(dictionary));
		}).filter(Boolean);
	}

	enable(...dictionaries) {
		dictionaries = this.filterDictionaries(dictionaries);

		if (this.isMultiLanguage) {
			this.enabledDictionaries = [
				...this.enabledDictionaries,
				...dictionaries,
			];
		} else {
			this.enabledDictionaries = [dictionaries[0]];
		}

		localStorage.setItem('spellcheckerDictionaries', JSON.stringify(this.enabledDictionaries));

		return this.enabledDictionaries.length > 0;
	}

	disable(...dictionaries) {
		dictionaries = this.filterDictionaries(dictionaries);

		this.enabledDictionaries = this.enabledDictionaries.filter((dictionary) => !dictionaries.includes(dictionary));
		localStorage.setItem('spellcheckerDictionaries', JSON.stringify(this.enabledDictionaries));
	}

	isCorrect(text) {
		if (!this.enabledDictionaries.length) {
			return true;
		}

		return this.enabledDictionaries.every((dictionary) => {
			spellchecker.setDictionary(dictionary, this.dictionariesPath);
			return !spellchecker.isMisspelled(text);
		});
	}

	getCorrections(text) {
		text = text.trim();

		if (text === '' || this.isCorrect(text)) {
			return null;
		}

		return Array.from(new Set(
			this.enabledDictionaries.flatMap((language) => {
				spellchecker.setDictionary(language, this.dictionariesPath);
				return spellchecker.getCorrectionsForMisspelling(text);
			})
		));
	}

	async installDictionaries(filePaths) {
		for (const filePath of filePaths) {
			const name = filePath.basename(filePath, filePath.extname(filePath));
			const basename = filePath.basename(filePath);
			const newPath = filePath.join(this.dictionariesPath, basename);

			await jetpack.copyAsync(filePath, newPath);

			if (!this.dictionaries.includes(name)) {
				this.dictionaries.push(name);
			}
		}
	}
}

const spellchecking = new SpellCheck;

var setupSpellcheckingPreload = () => {
	spellchecking.load();

	const spellCheck = (text) => spellchecking.isCorrect(text);
	electron.webFrame.setSpellCheckProvider('', false, { spellCheck });
};

const { dialog, getCurrentWebContents, getCurrentWindow, Menu } = electron.remote;


const createSpellCheckingMenuTemplate = async({
	isEditable,
	selectionText,
}) => {
	if (!isEditable) {
		return [];
	}

	const corrections = spellchecking.getCorrections(selectionText);

	const handleBrowserForLanguage = () => {
		const callback = async(filePaths) => {
			try {
				await spellchecking.installDictionaries(filePaths);
			} catch (error) {
				dialog.showErrorBox(i18n.__('Error'), `${ i18n.__('Error copying dictionary file') }: ${ name }`);
				console.error(error);
			}
		};

		dialog.showOpenDialog(getCurrentWindow(), {
			title: i18n.__('Open_Language_Dictionary'),
			defaultPath: spellchecking.dictionariesPath,
			filters: [
				{ name: i18n.__('Dictionaries'), extensions: ['aff', 'dic'] },
				{ name: i18n.__('All files'), extensions: ['*'] },
			],
			properties: ['openFile', 'multiSelections'],
		}, callback);
	};

	return [
		...(corrections ? [
			...(corrections.length === 0 ? (
				[
					{
						label: i18n.__('No_suggestions'),
						enabled: false,
					},
				]
			) : (
				corrections.slice(0, 6).map((correction) => ({
					label: correction,
					click: () => getCurrentWebContents().replaceMisspelling(correction),
				}))
			)),
			...(corrections.length > 6 ? [
				{
					label: i18n.__('More_spelling_suggestions'),
					submenu: corrections.slice(6).map((correction) => ({
						label: correction,
						click: () => getCurrentWebContents().replaceMisspelling(correction),
					})),
				},
			] : []),
			{
				type: 'separator',
			},
		] : []),
		{
			label: i18n.__('Spelling_languages'),
			enabled: spellchecking.dictionaries.length > 0,
			submenu: [
				...spellchecking.dictionaries.map((dictionaryName) => ({
					label: dictionaryName,
					type: 'checkbox',
					checked: spellchecking.enabledDictionaries.includes(dictionaryName),
					click: ({ checked }) => (checked ?
						spellchecking.enable(dictionaryName) :
						spellchecking.disable(dictionaryName)),
				})),
				{
					type: 'separator',
				},
				{
					label: i18n.__('Browse_for_language'),
					click: handleBrowserForLanguage,
				},
			],
		},
		{
			type: 'separator',
		},
	];
};

const createImageMenuTemplate = ({
	mediaType,
	srcURL,
}) => (
	mediaType === 'image' ?
		[
			{
				label: i18n.__('Save image as...'),
				click: () => getCurrentWebContents().downloadURL(srcURL),
			},
			{
				type: 'separator',
			},
		] :
		[]
);

const createLinkMenuTemplate = ({
	linkURL,
	linkText,
}) => (
	linkURL ?
		[
			{
				label: i18n.__('Open link'),
				click: () => electron.shell.openExternal(linkURL),
			},
			{
				label: i18n.__('Copy link text'),
				click: () => electron.clipboard.write({ text: linkText, bookmark: linkText }),
				enabled: !!linkText,
			},
			{
				label: i18n.__('Copy link address'),
				click: () => electron.clipboard.write({ text: linkURL, bookmark: linkText }),
			},
			{
				type: 'separator',
			},
		] :
		[]
);

const createDefaultMenuTemplate = ({
	editFlags: {
		canUndo = false,
		canRedo = false,
		canCut = false,
		canCopy = false,
		canPaste = false,
		canSelectAll = false,
	} = {},
} = {}) => [
	{
		label: i18n.__('&Undo'),
		role: 'undo',
		accelerator: 'CommandOrControl+Z',
		enabled: canUndo,
	},
	{
		label: i18n.__('&Redo'),
		role: 'redo',
		accelerator: process.platform === 'win32' ? 'Control+Y' : 'CommandOrControl+Shift+Z',
		enabled: canRedo,
	},
	{
		type: 'separator',
	},
	{
		label: i18n.__('Cu&t'),
		role: 'cut',
		accelerator: 'CommandOrControl+X',
		enabled: canCut,
	},
	{
		label: i18n.__('&Copy'),
		role: 'copy',
		accelerator: 'CommandOrControl+C',
		enabled: canCopy,
	},
	{
		label: i18n.__('&Paste'),
		role: 'paste',
		accelerator: 'CommandOrControl+V',
		enabled: canPaste,
	},
	{
		label: i18n.__('Select &all'),
		role: 'selectall',
		accelerator: 'CommandOrControl+A',
		enabled: canSelectAll,
	},
];

const createMenuTemplate = async(params) => [
	...(await createSpellCheckingMenuTemplate(params)),
	...(await createImageMenuTemplate(params)),
	...(await createLinkMenuTemplate(params)),
	...(await createDefaultMenuTemplate(params)),
];

var setupContextMenuPreload = () => {
	getCurrentWebContents().on('context-menu', (event, params) => {
		event.preventDefault();
		(async() => {
			const menu = Menu.buildFromTemplate(await createMenuTemplate(params));
			menu.popup({ window: getCurrentWindow() });
		})();
	});
};

const handleTitleChange = () => {
	const { Meteor, RocketChat, Tracker } = window;

	if (!Meteor || !RocketChat || !Tracker) {
		return;
	}

	Meteor.startup(() => {
		Tracker.autorun(() => {
			const siteName = RocketChat.settings.get('Site_Name');
			if (siteName) {
				electron.ipcRenderer.sendToHost('title-changed', siteName);
			}
		});
	});
};


const handleUserPresenceChange = () => {
	const { Meteor, UserPresence } = window;

	if (!Meteor || !UserPresence) {
		return;
	}

	const idleDetectionInterval = 10000;
	setInterval(() => {
		try {
			const idleTime = electron.ipcRenderer.sendSync('getSystemIdleTime');
			if (idleTime < idleDetectionInterval) {
				UserPresence.setOnline();
			}
		} catch (e) {
			console.error(`Error getting system idle time: ${ e }`);
		}
	}, idleDetectionInterval);
};


var setupEventsPreload = () => {
	document.addEventListener('dragover', (event) => event.preventDefault());
	document.addEventListener('drop', (event) => event.preventDefault());

	const eventsListened = ['unread-changed', 'get-sourceId', 'user-status-manually-set'];

	for (const eventName of eventsListened) {
		window.addEventListener(eventName, (event) => electron.ipcRenderer.sendToHost(eventName, event.detail));
	}

	window.addEventListener('load', () => {
		handleTitleChange();
		handleUserPresenceChange();
	});
};

const JitsiMeetElectron = {
	obtainDesktopStreams(callback, errorCallback, options = {}) {
		electron.desktopCapturer.getSources(options, (error, sources) => {
			if (error) {
				errorCallback(error);
				return;
			}

			callback(sources);
		});
	},
};


const wrapWindowOpen = (defaultWindowOpen) => (href, frameName, features) => {
	const { RocketChat } = window;

	if (RocketChat && url.parse(href).host === RocketChat.settings.get('Jitsi_Domain')) {
		features = [
			features,
			'nodeIntegration=true',
			`preload=${ path.join(__dirname, './preload.js') }`,
		].filter((x) => Boolean(x)).join(',');
	}

	return defaultWindowOpen(href, frameName, features);
};


const pollJitsiIframe = () => {
	const jitsiIframe = document.querySelector('iframe[id^=jitsiConference]');
	if (!jitsiIframe) {
		return;
	}

	jitsiIframe.contentWindow.JitsiMeetElectron = JitsiMeetElectron;
};


var setupJitsiPreload = () => {
	window.JitsiMeetElectron = JitsiMeetElectron;

	window.open = wrapWindowOpen(window.open);

	window.addEventListener('load', () => {
		setInterval(pollJitsiIframe, 1000);
	});
};

const handleAnchorClick = (event) => {
	const a = event.target.closest('a');

	if (!a) {
		return;
	}

	const href = a.getAttribute('href');
	const download = a.hasAttribute('download');

	const isFileUpload = /^\/file-upload\//.test(href) && !download;
	if (isFileUpload) {
		const clone = a.cloneNode();
		clone.setAttribute('download', 'download');
		clone.click();
		event.preventDefault();
		return;
	}

	const isLocalFilePath = /^file:\/\/.+/.test(href);
	if (isLocalFilePath) {
		const filePath = href.slice(6);
		electron.shell.showItemInFolder(filePath);
		event.preventDefault();
		return;
	}

	const { Meteor } = window;
	const isInsideDomain = Meteor && RegExp(`^${ Meteor.absoluteUrl() }`).test(href);
	const isRelative = !/^([a-z]+:)?\/\//.test(href);
	if (isInsideDomain || isRelative) {
		return;
	}

	electron.shell.openExternal(href);
	event.preventDefault();
};


var setupLinksPreload = () => {
	window.addEventListener('load', () => {
		document.addEventListener('click', handleAnchorClick, true);
	});
};

const instances = new Map();

class Notification extends events.EventEmitter {
	static requestPermission() {
		return;
	}

	static get permission() {
		return 'granted';
	}

	constructor(title, options) {
		super();

		this.create({ title, ...options });
	}

	async create({ icon, ...options }) {
		if (icon) {
			Notification.cachedIcons = Notification.cachedIcons || {};

			if (!Notification.cachedIcons[icon]) {
				Notification.cachedIcons[icon] = await new Promise((resolve, reject) =>
					tmp.file((err, path$$1) => (err ? reject(err) : resolve(path$$1))));
				const buffer = electron.nativeImage.createFromDataURL(icon).toPNG();
				await jetpack.writeAsync(Notification.cachedIcons[icon], buffer);
			}
			icon = Notification.cachedIcons[icon];
		}

		this.id = electron.ipcRenderer.sendSync('request-notification', { icon, ...options });
		instances.set(this.id, this);
	}

	close() {
		electron.ipcRenderer.send('close-notification', this.id);
	}
}

const handleNotificationShown = (event, id) => {
	const notification = instances.get(id);
	if (!notification) {
		return;
	}

	typeof notification.onshow === 'function' && notification.onshow.call(notification);
	notification.emit('show');
};

const handleNotificationClicked = (event, id) => {
	const notification = instances.get(id);
	if (!notification) {
		return;
	}

	electron.ipcRenderer.send('focus');
	electron.ipcRenderer.sendToHost('focus');

	typeof notification.onclick === 'function' && notification.onclick.call(notification);
	notification.emit('click');
};

const handleNotificationClosed = (event, id) => {
	const notification = instances.get(id);
	if (!notification) {
		return;
	}

	typeof notification.onclose === 'function' && notification.onclose.call(notification);
	notification.emit('close');
};


var setupNotificationsPreload = () => {
	window.Notification = Notification;
	electron.ipcRenderer.on('notification-shown', handleNotificationShown);
	electron.ipcRenderer.on('notification-clicked', handleNotificationClicked);
	electron.ipcRenderer.on('notification-closed', handleNotificationClosed);
};

const requestSidebarColor = function pollSidebarColor() {
	const sidebar = document.querySelector('.sidebar');
	if (sidebar) {
		const { color, background } = window.getComputedStyle(sidebar);
		const sidebarItem = sidebar.querySelector('.sidebar-item');
		const itemColor = sidebarItem && window.getComputedStyle(sidebarItem).color;
		electron.ipcRenderer.sendToHost('sidebar-background', { color: itemColor || color, background });
		return;
	}

	const fullpage = document.querySelector('.full-page');
	if (fullpage) {
		const { color, background } = window.getComputedStyle(fullpage);
		electron.ipcRenderer.sendToHost('sidebar-background', { color, background });
		return;
	}

	requestAnimationFrame(pollSidebarColor);
};

var setupSidebarPreload = () => {
	electron.ipcRenderer.on('request-sidebar-color', requestSidebarColor);
};

setupContextMenuPreload();
setupEventsPreload();
setupJitsiPreload();
setupLinksPreload();
setupNotificationsPreload();
setupSidebarPreload();
setupSpellcheckingPreload();

window.reloadServer = () => electron.ipcRenderer.sendToHost('reload-server');
window.i18n = require('./i18n');

})()
//# sourceMappingURL=preload.js.map
