'use strict';

(function () {

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var electron = require('electron');
var querystring = _interopDefault(require('querystring'));
var url = _interopDefault(require('url'));
var idle = _interopDefault(require('@paulcbetts/system-idle-time'));
var jetpack = _interopDefault(require('fs-jetpack'));
var path = _interopDefault(require('path'));
var fs = _interopDefault(require('fs'));
var util = _interopDefault(require('util'));
var events = require('events');
var freedesktopNotifications = _interopDefault(require('freedesktop-notifications'));
var os = _interopDefault(require('os'));
var electronUpdater = require('electron-updater');

const debounce = (f, delay) => {
	let call;
	let timeout;


	const ret = function(...args) {
		call = () => f.apply(this, args);
		clearTimeout(timeout);
		timeout = setTimeout(call, delay);
	};

	ret.flush = () => {
		clearTimeout(timeout);
		call();
	};

	return ret;
};

var createWindowStateKeeper = (name, defaults) => {

	let state = {
		width: defaults.width,
		height: defaults.height,
	};

	const userDataDir = jetpack.cwd(electron.app.getPath('userData'));
	const stateStoreFile = `window-state-${ name }.json`;

	try {
		state = userDataDir.read(stateStoreFile, 'json') || state;
	} catch (err) {
		console.error(`Failed to load "${ name }" window state`);
		console.error(err);
	}

	const saveState = (window) => {
		if (window.isDestroyed()) {
			return;
		}

		state.isMaximized = window.isMaximized();
		state.isMinimized = window.isMinimized();
		state.isHidden = !window.isMinimized() && !window.isVisible();

		if (!state.isMaximized && !state.isHidden) {
			[state.x, state.y] = window.getPosition();
			[state.width, state.height] = window.getSize();
		}

		userDataDir.write(stateStoreFile, state, { atomic: true });
	};

	const isInsideSomeScreen = (state) => electron.screen.getAllDisplays().some(({ bounds }) => (
		state.x >= bounds.x &&
		state.y >= bounds.y &&
		state.x + state.width <= bounds.x + bounds.width &&
		state.y + state.height <= bounds.y + bounds.height
	));

	const loadState = function(window) {
		if (!isInsideSomeScreen(state)) {
			const { bounds } = electron.screen.getPrimaryDisplay();
			state.x = (bounds.width - defaults.width) / 2;
			state.y = (bounds.height - defaults.height) / 2;
			state.width = defaults.width;
			state.height = defaults.height;
		}

		if (this.x !== undefined && this.y !== undefined) {
			window.setPosition(this.x, this.y, false);
		}

		if (this.width !== undefined && this.height !== undefined) {
			window.setSize(this.width, this.height, false);
		}

		this.isMaximized ? window.maximize() : window.unmaximize();
		this.isMinimized ? window.minimize() : window.restore();
		this.isHidden ? window.hide() : window.show();
	};

	return {
		get x() { return state.x && Math.floor(state.x); },
		get y() { return state.y && Math.floor(state.y); },
		get width() { return state.width && Math.floor(state.width); },
		get height() { return state.height && Math.floor(state.height); },
		get isMaximized() { return state.isMaximized; },
		get isMinimized() { return state.isMinimized; },
		get isHidden() { return state.isHidden; },
		saveState: debounce(saveState, 1000), // see https://github.com/RocketChat/Rocket.Chat.Electron/issues/181
		loadState,
	};
};

const whenReady = electron.app.whenReady || (() => new Promise((resolve) => {
	electron.app.isReady() ? resolve() : electron.app.once('ready', () => resolve());
}));

const whenReadyToShow =
	(window) => new Promise((resolve) => window.on('ready-to-show', resolve));

var env = require('./env.json');

let rendererWindow = null;

const getRendererWindow = async() => {
	if (!rendererWindow) {
		rendererWindow = new electron.BrowserWindow({ show: false });

		const dataURL = `data:text/html,<!doctype html>
		${ jetpack.read(`${ __dirname }/public/images/icon.svg`) }`;

		rendererWindow.loadURL(dataURL);
		await whenReadyToShow(rendererWindow);
	}

	return rendererWindow;
};

/* istanbul ignore next */
const renderInWindow = async(style) => {
	const statusColors = {
		offline: null,
		away: 'yellow',
		busy: 'red',
		online: 'lime',
	};

	const create = ({ overlay, template, status, badgeText } = {}) => {
		const svg = document.querySelector('#icon').cloneNode(true);

		svg.querySelector('.logo .baloon').style.fill = template ? '#FFFFFF' : '#DB2323';
		svg.querySelector('.logo .circles').style.fill = template ? '#FFFFFF' : '#DB2323';
		svg.querySelector('.status .away').style.fill = template ? '#FFFFFF' : '#DB2323';
		svg.querySelector('.status .busy').style.fill = template ? '#FFFFFF' : '#DB2323';

		svg.querySelector('.logo .bubble').style.display = template ? 'none' : null;

		svg.querySelector('.badge').style.display = (!template && badgeText) ? null : 'none';
		svg.querySelector('.badge text').innerHTML = badgeText;

		svg.querySelector('.logo .circles').style.display = (template && status && status !== 'online') ? 'none' : '';
		svg.querySelector('.status circle').style.display = (template || !status) ? 'none' : null;
		svg.querySelector('.status .away').style.display = (template && status === 'away') ? null : 'none';
		svg.querySelector('.status .busy').style.display = (template && status === 'busy') ? null : 'none';
		svg.querySelector('.status circle').style.fill = statusColors[status];

		if (overlay) {
			const overlaySVG = svg.cloneNode(true);
			svg.remove();

			overlaySVG.querySelector('.logo').remove();
			overlaySVG.querySelector('.status').remove();
			overlaySVG.setAttribute('viewBox', '96 -32 160 160');

			return overlaySVG;
		}

		return svg;
	};

	const rasterize = async(svg, size) => {
		const image = new Image();
		image.src = `data:image/svg+xml,${ encodeURIComponent(svg.outerHTML) }`;
		image.width = image.height = size;
		await new Promise((resolve, reject) => {
			image.onload = resolve;
			image.onerror = reject;
		});

		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = size;

		const ctx = canvas.getContext('2d');
		ctx.drawImage(image, 0, 0);

		return canvas.toDataURL('image/png');
	};

	const svg = create(style);
	const pixelRatio = window.devicePixelRatio;
	const sizes = Array.isArray(style.size) ? style.size : [style.size || 256];
	const images = await Promise.all(sizes.map(async(size) => ({
		dataURL: await rasterize(svg, size * pixelRatio),
		size,
		pixelRatio,
	})));
	svg.remove();
	return images;
};

const render = async(style = {}) => {
	const encodedArgs = JSON.stringify(style);
	render.cache = render.cache || [];

	if (render.cache[encodedArgs]) {
		return render.cache[encodedArgs];
	}

	const rendererWindow = await getRendererWindow();
	const jsCode = `(${ renderInWindow.toString() })(${ encodedArgs })`;
	const images = await rendererWindow.webContents.executeJavaScript(jsCode);
	const image = electron.nativeImage.createEmpty();
	for (const { dataURL, size, pixelRatio } of images) {
		image.addRepresentation({
			scaleFactor: pixelRatio,
			width: size,
			height: size,
			dataURL,
		});
	}
	image.setTemplateImage(style.template || false);
	render.cache[encodedArgs] = image;

	return image;
};

var icon = {
	render,
};

let mainWindow = null;

let state = {
	hideOnClose: false,
};

const mainWindowOptions = {
	width: 1000,
	height: 600,
	minWidth: 600,
	minHeight: 400,
	titleBarStyle: 'hidden',
	show: false,
};

const setState = (partialState) => {
	state = {
		...state,
		...partialState,
	};
};

const attachWindowStateHandling = (mainWindow) => {
	const windowStateKeeper = createWindowStateKeeper('main', mainWindowOptions);
	whenReadyToShow(mainWindow).then(() => windowStateKeeper.loadState(mainWindow));

	const exitFullscreen = () => new Promise((resolve) => {
		if (mainWindow.isFullScreen()) {
			mainWindow.once('leave-full-screen', resolve);
			mainWindow.setFullScreen(false);
			return;
		}
		resolve();
	});

	const close = () => {
		mainWindow.blur();

		if (process.platform === 'darwin' || state.hideOnClose) {
			mainWindow.hide();
		} else if (process.platform === 'win32') {
			mainWindow.minimize();
		} else {
			electron.app.quit();
		}
	};

	electron.app.on('activate', () => mainWindow && mainWindow.show());
	electron.app.on('before-quit', () => {
		windowStateKeeper.saveState.flush();
		mainWindow = null;
	});

	mainWindow.on('resize', () => windowStateKeeper.saveState(mainWindow));
	mainWindow.on('move', () => windowStateKeeper.saveState(mainWindow));
	mainWindow.on('show', () => windowStateKeeper.saveState(mainWindow));
	mainWindow.on('close', async(event) => {
		if (!mainWindow) {
			return;
		}

		event.preventDefault();
		await exitFullscreen();
		close();
		windowStateKeeper.saveState(mainWindow);
	});

	mainWindow.on('set-state', setState);
};

const getMainWindow = async() => {
	await whenReady();

	if (!mainWindow) {
		mainWindow = new electron.BrowserWindow(mainWindowOptions);
		mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
		mainWindow.loadURL(`file://${ __dirname }/public/app.html`);
		attachWindowStateHandling(mainWindow);

		if (process.platform !== 'darwin') {
			mainWindow.setIcon(await icon.render({
				size: {
					win32: [256, 128, 64, 48, 32, 24, 16],
					linux: 128,
				}[process.platform],
			}));
		}

		if (env.name === 'development') {
			mainWindow.openDevTools();
		}
	}

	return mainWindow;
};

const addServer = (serverUrl) => getMainWindow().then((mainWindow) => {
	mainWindow.show();

	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}

	mainWindow.send('add-host', serverUrl);
});

electron.ipcMain.on('focus', async() => {
	const mainWindow = await getMainWindow();

	if (process.platform === 'win32') {
		if (mainWindow.isVisible()) {
			mainWindow.focus();
		} else if (mainWindow.isMinimized()) {
			mainWindow.restore();
		} else {
			mainWindow.show();
		}

		return;
	}

	if (mainWindow.isMinimized()) {
		mainWindow.restore();
		return;
	}

	mainWindow.show();
});

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

let aboutWindow;

const openAboutDialog = async() => {
	if (aboutWindow) {
		return;
	}

	const mainWindow = await getMainWindow();
	aboutWindow = new electron.BrowserWindow({
		title: i18n.__('About %s', electron.app.getName()),
		parent: mainWindow,
		modal: process.platform !== 'darwin',
		width: 400,
		height: 300,
		type: 'toolbar',
		resizable: false,
		fullscreenable: false,
		maximizable: false,
		minimizable: false,
		fullscreen: false,
		show: false,
	});
	aboutWindow.setMenuBarVisibility(false);

	aboutWindow.once('ready-to-show', () => {
		aboutWindow.show();
	});

	aboutWindow.once('closed', () => {
		aboutWindow = null;
	});

	aboutWindow.params = { appName: electron.app.getName(), appVersion: electron.app.getVersion() };

	aboutWindow.loadFile(`${ __dirname }/public/about-dialog.html`);
};

const closeAboutDialog = () => {
	aboutWindow && aboutWindow.destroy();
};

electron.ipcMain.on('open-about-dialog', () => openAboutDialog());
electron.ipcMain.on('close-about-dialog', () => closeAboutDialog());

const definePath = () => {
	const appName = electron.app.getName();
	const dirName = env.name === 'production' ? appName : `${ appName } (${ env.name })`;

	electron.app.setPath('userData', path.join(electron.app.getPath('appData'), dirName));
};

const reset = () => {
	const dataDir = electron.app.getPath('userData');
	jetpack.remove(dataDir);
	electron.app.relaunch({ args: [process.argv[1]] });
	electron.app.quit();
};

const migrate = () => {
	const olderAppName = 'Rocket.Chat+';
	const dirName = env.name === 'production' ? olderAppName : `${ olderAppName } (${ env.name })`;
	const olderUserDataPath = path.join(electron.app.getPath('appData'), dirName);

	try {
		jetpack.copy(olderUserDataPath, electron.app.getPath('userData'), { overwrite: true });
		jetpack.remove(olderUserDataPath);
	} catch (e) {
		return;
	}
};

const initialize = () => {
	definePath();

	if (process.argv[2] === '--reset-app-data') {
		reset();
		return;
	}

	migrate();
};

electron.ipcMain.on('reset-app-data', () => {
	electron.app.relaunch({ args: [process.argv[1], '--reset-app-data'] });
	electron.app.quit();
});

var appData = {
	initialize,
};

class CertificateStore {
	initWindow(win) {
		this.storeFileName = 'certificate.json';
		this.userDataDir = jetpack.cwd(electron.app.getPath('userData'));

		this.load();

		// Don't ask twice for same cert if loading multiple urls
		this.queued = {};

		this.window = win;
		electron.app.on('certificate-error', (event, webContents, url$$1, error, certificate, callback) => {
			event.preventDefault();
			if (this.isTrusted(url$$1, certificate)) {
				callback(true);
				return;
			}

			if (this.queued[certificate.fingerprint]) {
				this.queued[certificate.fingerprint].push(callback);
				// Call the callback after approved/rejected
				return;
			} else {
				this.queued[certificate.fingerprint] = [callback];
			}

			let detail = `URL: ${ url$$1 }\nError: ${ error }`;
			if (this.isExisting(url$$1)) {
				detail = i18n.__('Certificate_error_different', detail);
			}

			electron.dialog.showMessageBox(this.window, {
				title: i18n.__('Certificate_error'),
				message: i18n.__('Certificate_error_message', certificate.issuerName),
				detail,
				type: 'warning',
				buttons: [
					i18n.__('Yes'),
					i18n.__('No'),
				],
				cancelId: 1,
			}, (response) => {
				if (response === 0) {
					this.add(url$$1, certificate);
					this.save();
					if (webContents.getURL().indexOf('file://') === 0) {
						webContents.send('certificate-reload', url$$1);
					}
				}
				// Call all queued callbacks with result
				this.queued[certificate.fingerprint].forEach((cb) => cb(response === 0));
				delete this.queued[certificate.fingerprint];
			});
		});
	}

	load() {
		try {
			this.data = this.userDataDir.read(this.storeFileName, 'json');
		} catch (e) {
			console.error(e);
			this.data = {};
		}

		if (this.data === undefined) {
			this.clear();
		}
	}

	clear() {
		this.data = {};
		this.save();
	}

	save() {
		this.userDataDir.write(this.storeFileName, this.data, { atomic: true });
	}

	parseCertificate(certificate) {
		return `${ certificate.issuerName }\n${ certificate.data.toString() }`;
	}

	getHost(certUrl) {
		return url.parse(certUrl).host;
	}

	add(certUrl, certificate) {
		const host = this.getHost(certUrl);
		this.data[host] = this.parseCertificate(certificate);
	}

	isExisting(certUrl) {
		const host = this.getHost(certUrl);
		return this.data.hasOwnProperty(host);
	}

	isTrusted(certUrl, certificate) {
		const host = this.getHost(certUrl);
		if (!this.isExisting(certUrl)) {
			return false;
		}
		return this.data[host] === this.parseCertificate(certificate);
	}
}

const certificateStore = new CertificateStore();

const getBadgeText = ({ badge: { title, count } }) => {
	if (title === '•') {
		return '•';
	} else if (count > 0) {
		return count > 9 ? '9+' : String(count);
	} else if (title) {
		return '!';
	}
};

let state$1 = {
	badge: {
		title: '',
		count: 0,
	},
	status: 'online',
};

const instance = new (class Dock extends events.EventEmitter {});

const destroy = () => {
	instance.removeAllListeners();
};

const update = async(previousState) => {
	const mainWindow = await getMainWindow();
	const badgeText = getBadgeText(state$1);

	if (process.platform === 'win32') {
		const image = badgeText ? await icon.render({
			overlay: true,
			size: 16,
			badgeText,
		}) : null;
		mainWindow.setOverlayIcon(image, badgeText || '');

		mainWindow.removeListener('show', update);
		mainWindow.on('show', update);
	}

	if (process.platform === 'darwin') {
		electron.app.dock.setBadge(badgeText || '');
		if (state$1.badge.count > 0 && previousState.badge.count === 0) {
			electron.app.dock.bounce();
		}
	}

	if (process.platform === 'linux') {
		mainWindow.setIcon(await icon.render({
			badgeText,
			size: {
				win32: [256, 128, 64, 48, 32, 24, 16],
				linux: 128,
			}[process.platform],
		}));
	}

	if (!mainWindow.isFocused()) {
		mainWindow.flashFrame(state$1.badge.count > 0);
	}

	instance.emit('update');
};

const setState$1 = (partialState) => {
	const previousState = state$1;
	state$1 = {
		...state$1,
		...partialState,
	};
	update(previousState);
};

var dock = Object.assign(instance, {
	destroy,
	setState: setState$1,
});

const createTemplate = ({
	appName,
	servers = [],
	currentServerUrl = null,
	showTrayIcon = true,
	showUserStatusInTray = true,
	showFullScreen = false,
	showMenuBar = true,
	showServerList = true,
	showWindowOnUnreadChanged = false,
}, events$$1) => ([
	{
		label: process.platform === 'darwin' ? appName : i18n.__('&File'),
		submenu: [
			...(process.platform === 'darwin' ? [
				{
					id: 'about',
					label: i18n.__('About %s', appName),
					click: () => events$$1.emit('about'),
				},
				{
					type: 'separator',
				},
				{
					submenu: [],
					role: 'services',
				},
				{
					type: 'separator',
				},
				{
					accelerator: 'Command+H',
					role: 'hide',
				},
				{
					accelerator: 'Command+Alt+H',
					role: 'hideothers',
				},
				{
					role: 'unhide',
				},
				{
					type: 'separator',
				},
			] : []),
			// {
			// 	label: i18n.__('Preferences'),
			// 	accelerator: 'CommandOrControl+,',
			// 	click: () => events.emit('preferences'),
			// },
			...(process.platform !== 'darwin' ? [
				{
					label: i18n.__('Add &new server'),
					accelerator: 'CommandOrControl+N',
					click: () => events$$1.emit('add-new-server'),
				},
			] : []),
			{
				type: 'separator',
			},
			{
				id: 'quit',
				label: i18n.__('&Quit %s', appName),
				accelerator: 'CommandOrControl+Q',
				click: () => events$$1.emit('quit'),
			},
		],
	},
	{
		label: i18n.__('&Edit'),
		submenu: [
			{
				label: i18n.__('&Undo'),
				accelerator: 'CommandOrControl+Z',
				role: 'undo',
			},
			{
				label: i18n.__('&Redo'),
				accelerator: process.platform === 'win32' ? 'Control+Y' : 'CommandOrControl+Shift+Z',
				role: 'redo',
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('Cu&t'),
				accelerator: 'CommandOrControl+X',
				role: 'cut',
			},
			{
				label: i18n.__('&Copy'),
				accelerator: 'CommandOrControl+C',
				role: 'copy',
			},
			{
				label: i18n.__('&Paste'),
				accelerator: 'CommandOrControl+V',
				role: 'paste',
			},
			{
				label: i18n.__('Select &all'),
				accelerator: 'CommandOrControl+A',
				role: 'selectall',
			},
		],
	},
	{
		label: i18n.__('&View'),
		submenu: [
			{
				label: i18n.__('&Reload'),
				accelerator: 'CommandOrControl+R',
				click: () => events$$1.emit('reload-server'),
			},
			{
				label: i18n.__('Reload ignoring cache'),
				click: () => events$$1.emit('reload-server', { ignoringCache: true }),
			},
			{
				label: i18n.__('Clear trusted certificates'),
				click: () => events$$1.emit('reload-server', { ignoringCache: true, clearCertificates: true }),
			},
			{
				label: i18n.__('Open &DevTools'),
				accelerator: process.platform === 'darwin' ? 'Command+Alt+I' : 'Ctrl+Shift+I',
				click: () => events$$1.emit('open-devtools-for-server'),
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('&Back'),
				accelerator: process.platform === 'darwin' ? 'Command+[' : 'Alt+Left',
				click: () => events$$1.emit('go-back'),
			},
			{
				label: i18n.__('&Forward'),
				accelerator: process.platform === 'darwin' ? 'Command+]' : 'Alt+Right',
				click: () => events$$1.emit('go-forward'),
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('Tray icon'),
				type: 'checkbox',
				checked: showTrayIcon,
				click: () => events$$1.emit('toggle', 'showTrayIcon'),
			},
			{
				label: i18n.__('User status in tray'),
				type: 'checkbox',
				enabled: showTrayIcon,
				checked: showTrayIcon && showUserStatusInTray,
				click: () => events$$1.emit('toggle', 'showUserStatusInTray'),
			},
			...(process.platform === 'darwin' ? [
				{
					label: i18n.__('Full screen'),
					type: 'checkbox',
					checked: showFullScreen,
					accelerator: 'Control+Command+F',
					click: () => events$$1.emit('toggle', 'showFullScreen'),
				},
			] : [
				{
					label: i18n.__('Menu bar'),
					type: 'checkbox',
					checked: showMenuBar,
					click: () => events$$1.emit('toggle', 'showMenuBar'),
				},
			]),
			{
				label: i18n.__('Server list'),
				type: 'checkbox',
				checked: showServerList,
				click: () => events$$1.emit('toggle', 'showServerList'),
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('Reset zoom'),
				accelerator: 'CommandOrControl+0',
				role: 'resetzoom',
			},
			{
				label: i18n.__('Zoom in'),
				accelerator: 'CommandOrControl+Plus',
				role: 'zoomin',
			},
			{
				label: i18n.__('Zoom out'),
				accelerator: 'CommandOrControl+-',
				role: 'zoomout',
			},
		],
	},
	{
		label: i18n.__('&Window'),
		id: 'window',
		role: 'window',
		submenu: [
			...(process.platform === 'darwin' ? [
				{
					label: i18n.__('Add &new server'),
					accelerator: 'CommandOrControl+N',
					click: () => events$$1.emit('add-new-server'),
				},
				{
					type: 'separator',
				},
			] : []),
			...servers.map((host, i) => ({
				label: host.title.replace(/&/g, '&&'),
				type: currentServerUrl ? 'radio' : 'normal',
				checked: currentServerUrl === host.url,
				accelerator: `CommandOrControl+${ i + 1 }`,
				id: host.url,
				click: () => events$$1.emit('select-server', host),
			})),
			{
				type: 'separator',
			},
			{
				label: i18n.__('&Reload'),
				accelerator: 'CommandOrControl+Shift+R',
				click: () => events$$1.emit('reload-app'),
			},
			{
				label: i18n.__('Toggle &DevTools'),
				click: () => events$$1.emit('toggle-devtools'),
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('Show on unread messages'),
				type: 'checkbox',
				checked: showWindowOnUnreadChanged,
				click: () => events$$1.emit('toggle', 'showWindowOnUnreadChanged'),
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('Minimize'),
				accelerator: 'CommandOrControl+M',
				role: 'minimize',
			},
			{
				label: i18n.__('Close'),
				accelerator: 'CommandOrControl+W',
				role: 'close',
			},
		],
	},
	{
		label: i18n.__('&Help'),
		role: 'help',
		submenu: [
			{
				label: i18n.__('Documentation'),
				click: () => events$$1.emit('open-url', 'https://rocket.chat/docs'),
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('Report issue'),
				click: () => events$$1.emit('open-url', 'https://github.com/RocketChat/Rocket.Chat.Electron/issues/new'),
			},
			{
				label: i18n.__('Reset app data'),
				click: () => events$$1.emit('reset-app-data'),
			},
			{
				type: 'separator',
			},
			{
				label: i18n.__('Learn more'),
				click: () => events$$1.emit('open-url', 'https://rocket.chat'),
			},
			...(process.platform !== 'darwin' ? [
				{
					id: 'about',
					label: i18n.__('About %s', appName),
					click: () => events$$1.emit('about'),
				},
			] : []),
		],
	},
]);

class Menus extends events.EventEmitter {
	constructor() {
		super();
		this.state = {};
	}

	setState(partialState) {
		this.state = {
			...this.state,
			...partialState,
		};
		this.update();
	}

	getItem(id) {
		return electron.Menu.getApplicationMenu().getMenuItemById(id);
	}

	async update() {
		const template = createTemplate({ appName: electron.app.getName(), ...this.state }, this);
		const menu = electron.Menu.buildFromTemplate(template);
		electron.Menu.setApplicationMenu(menu);

		if (process.platform !== 'darwin') {
			const { showMenuBar } = this.state;
			const mainWindow = await getMainWindow();
			mainWindow.setAutoHideMenuBar(!showMenuBar);
			mainWindow.setMenuBarVisibility(!!showMenuBar);
		}

		this.emit('update');
	}
}

var menus = new Menus();

class BaseNotification {
	constructor(options = {}) {
		this.handleShow = this.handleShow.bind(this);
		this.handleClick = this.handleClick.bind(this);
		this.handleClose = this.handleClose.bind(this);
		this.initialize(options);
	}

	handleShow() {
		const { id, eventTarget } = this;
		eventTarget && !eventTarget.isDestroyed() && eventTarget.send('notification-shown', id);
	}

	handleClick() {
		const { id, eventTarget } = this;
		eventTarget && !eventTarget.isDestroyed() && eventTarget.send('notification-clicked', id);
	}

	handleClose() {
		const { id, eventTarget } = this;
		eventTarget && !eventTarget.isDestroyed() && eventTarget.send('notification-closed', id);
	}

	initialize(/* options = {} */) {}
	reset(/* options = {} */) {}
	show() {}
	close() {}
}


class ElectronNotification extends BaseNotification {
	initialize({ title, body, icon, silent } = {}) {
		this.notification = new electron.Notification({
			title,
			body,
			icon: icon && path.resolve(icon),
			silent,
		});

		this.notification.on('show', this.handleShow);
		this.notification.on('click', this.handleClick);
		this.notification.on('close', this.handleClose);
	}

	reset(options = {}) {
		this.notification.removeAllListeners();
		this.notification.close();
		this.createNotification(options);
	}

	show() {
		this.notification.show();
	}

	close() {
		this.notification.close();
	}
}


class FreeDesktopNotification extends BaseNotification {
	escapeBody(body) {
		const escapeMap = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			'\'': '&#x27;',
			'`': '&#x60;',
		};

		const escapeRegex = new RegExp(`(?:${ Object.keys(escapeMap).join('|') })`, 'g');

		return body.replace(escapeRegex, (match) => escapeMap[match]);
	}

	initialize({ title, body, icon, silent } = {}) {
		this.notification = freedesktopNotifications.createNotification({
			summary: title,
			body: body && this.escapeBody(body),
			icon: icon ? path.resolve(icon) : 'info',
			appName: electron.app.getName(),
			timeout: 24 * 60 * 60 * 1000,
			sound: silent ? undefined : 'message-new-instant',
			actions: process.env.XDG_CURRENT_DESKTOP !== 'Unity' ? {
				default: '',
			} : null,
		});

		this.notification.on('action', (action) => action === 'default' && this.handleClick());
		this.notification.on('close', this.handleClose);
	}

	reset({ title, body, icon } = {}) {
		this.notification.set({
			summary: title,
			body,
			icon: icon ? path.resolve(icon) : 'info',
		});
	}

	show() {
		this.notification.push(this.handleShow);
	}

	close() {
		this.notification.close();
	}
}


const ImplementatedNotification = (() => {
	if (os.platform() === 'linux') {
		return FreeDesktopNotification;
	}

	return ElectronNotification;
})();

const instances = new Map();

let creationCount = 1;

const createOrGetNotification = (options = {}) => {
	const tag = options.tag ? JSON.stringify(options.tag) : null;

	if (!tag || !instances.get(tag)) {
		const notification = new ImplementatedNotification(options);
		notification.id = tag || creationCount++;

		instances.set(notification.id, notification);
		return notification;
	}

	const notification = instances.get(tag);
	notification.reset(options);
	return notification;
};


electron.ipcMain.on('request-notification', (event, options) => {
	try {
		const notification = createOrGetNotification(options);
		notification.eventTarget = event.sender;
		event.returnValue = notification.id;
		setImmediate(() => notification.show());
	} catch (e) {
		console.error(e);
		event.returnValue = -1;
	}
});

electron.ipcMain.on('close-notification', (event, id) => {
	try {
		const notification = instances.get(id);
		if (notification) {
			notification.close();
			instances.delete(id);
		}
	} catch (e) {
		console.error(e);
	}
});


electron.app.on('before-quit', () => {
	instances.forEach((notification) => {
		notification.close();
	});
});

let screenshareWindow;

const openScreenshareDialog = async() => {
	if (screenshareWindow) {
		return;
	}

	const mainWindow = await getMainWindow();
	screenshareWindow = new electron.BrowserWindow({
		title: i18n.__('About %s', electron.app.getName()),
		parent: mainWindow,
		width: 776,
		height: 600,
		type: 'toolbar',
		resizable: false,
		fullscreenable: false,
		maximizable: false,
		minimizable: false,
		fullscreen: false,
		skipTaskbar: false,
		center: true,
		show: false,
	});
	screenshareWindow.setMenuBarVisibility(false);

	screenshareWindow.once('ready-to-show', () => {
		screenshareWindow.show();
	});

	screenshareWindow.once('closed', () => {
		if (!screenshareWindow.resultSent) {
			mainWindow.webContents.send('screenshare-result', 'PermissionDeniedError');
		}
		screenshareWindow = null;
	});

	screenshareWindow.loadFile(`${ __dirname }/public/screenshare-dialog.html`);
};

const closeScreenshareDialog = () => {
	screenshareWindow && screenshareWindow.destroy();
};

const selectScreenshareSource = async(id) => {
	const mainWindow = await getMainWindow();
	mainWindow.webContents.send('screenshare-result', id);
	if (screenshareWindow) {
		screenshareWindow.resultSent = true;
		screenshareWindow.destroy();
	}
};

electron.ipcMain.on('open-screenshare-dialog', () => openScreenshareDialog());
electron.ipcMain.on('close-screenshare-dialog', () => closeScreenshareDialog());
electron.ipcMain.on('select-screenshare-source', (e, id) => selectScreenshareSource(id));

const getIconStyle = ({ badge: { title, count }, status, showUserStatus }) => {
	const style = {
		template: process.platform === 'darwin',
		size: {
			darwin: 24,
			win32: [32, 24, 16],
			linux: 22,
		}[process.platform],
	};

	if (showUserStatus) {
		style.status = status;
	}

	if (process.platform !== 'darwin') {
		if (title === '•') {
			style.badgeText = '•';
		} else if (count > 0) {
			style.badgeText = count > 9 ? '9+' : String(count);
		} else if (title) {
			style.badgeText = '!';
		}
	}

	return style;
};

const getIconTitle = ({ badge: { title, count } }) => ((count > 0) ? title : '');

const getIconTooltip = ({ badge: { count } }) => i18n.pluralize('Message_count', count, count);

const createContextMenuTemplate = ({ isMainWindowVisible }, events$$1) => ([
	{
		label: !isMainWindowVisible ? i18n.__('Show') : i18n.__('Hide'),
		click: () => events$$1.emit('set-main-window-visibility', !isMainWindowVisible),
	},
	{
		label: i18n.__('Quit'),
		click: () => events$$1.emit('quit'),
	},
]);

let trayIcon = null;

let state$2 = {
	badge: {
		title: '',
		count: 0,
	},
	status: 'online',
	isMainWindowVisible: true,
	showIcon: true,
	showUserStatus: true,
};

const instance$1 = new (class Tray extends events.EventEmitter {});

const createIcon = (image) => {
	if (trayIcon) {
		return;
	}

	trayIcon = new electron.Tray(image);

	trayIcon.on('click', () => instance$1.emit('set-main-window-visibility', !state$2.isMainWindowVisible));
	trayIcon.on('right-click', (event, bounds) => trayIcon.popUpContextMenu(undefined, bounds));

	instance$1.emit('created');
};

const destroyIcon = () => {
	if (!trayIcon) {
		return;
	}

	trayIcon.destroy();
	instance$1.emit('destroyed');
	trayIcon = null;
};

const destroy$1 = () => {
	destroyIcon();
	instance$1.removeAllListeners();
};

const update$1 = async() => {
	if (!state$2.showIcon) {
		destroyIcon();
		instance$1.emit('update');
		return;
	}

	const image = await icon.render(getIconStyle(state$2));

	if (!trayIcon) {
		createIcon(image);
	} else {
		trayIcon.setImage(image);
	}

	trayIcon.setToolTip(getIconTooltip(state$2));

	if (process.platform === 'darwin') {
		trayIcon.setTitle(getIconTitle(state$2));
	}

	const template = createContextMenuTemplate(state$2, instance$1);
	const menu = electron.Menu.buildFromTemplate(template);
	trayIcon.setContextMenu(menu);
	instance$1.emit('update');
};

const setState$2 = (partialState) => {
	state$2 = {
		...state$2,
		...partialState,
	};
	update$1();
};

var tray = Object.assign(instance$1, {
	destroy: destroy$1,
	setState: setState$2,
});

let updateWindow;

const openUpdateDialog = async({ currentVersion = electron.app.getVersion(), newVersion } = {}) => {
	if (updateWindow) {
		return;
	}

	const mainWindow = await getMainWindow();
	updateWindow = new electron.BrowserWindow({
		title: i18n.__('Update_Available'),
		parent: mainWindow,
		modal: process.platform !== 'darwin',
		width: 600,
		height: 330,
		type: 'toolbar',
		resizable: false,
		fullscreenable: false,
		maximizable: false,
		minimizable: false,
		fullscreen: false,
		show: false,
	});
	updateWindow.setMenuBarVisibility(false);

	updateWindow.once('ready-to-show', () => {
		updateWindow.show();
	});

	updateWindow.once('closed', () => {
		updateWindow = null;
	});

	updateWindow.params = { currentVersion, newVersion };

	updateWindow.loadFile(`${ __dirname }/public/update-dialog.html`);
};

const closeUpdateDialog = () => {
	updateWindow.destroy();
};

electron.ipcMain.on('open-update-dialog', (e, ...args) => openUpdateDialog(...args));
electron.ipcMain.on('close-update-dialog', () => closeUpdateDialog());

const appDir = jetpack.cwd(electron.app.getAppPath(), electron.app.getAppPath().endsWith('app.asar') ? '..' : '.');
const userDataDir = jetpack.cwd(electron.app.getPath('userData'));
const updateSettingsFileName = 'update.json';

const loadUpdateSettings = (dir) => {
	try {
		return dir.read(updateSettingsFileName, 'json') || {};
	} catch (error) {
		console.error(error);
		return {};
	}
};

const appUpdateSettings = loadUpdateSettings(appDir);
const userUpdateSettings = loadUpdateSettings(userDataDir);
const updateSettings = (() => {
	const defaultUpdateSettings = { autoUpdate: true, canUpdate: true };

	if (appUpdateSettings.forced) {
		return Object.assign({}, defaultUpdateSettings, appUpdateSettings);
	} else {
		return Object.assign({}, defaultUpdateSettings, appUpdateSettings, userUpdateSettings);
	}
})();
delete updateSettings.forced;

const saveUpdateSettings = () => {
	if (appUpdateSettings.forced) {
		return;
	}

	userDataDir.write(updateSettingsFileName, userUpdateSettings, { atomic: true });
};

const canUpdate = () => updateSettings.canUpdate &&
	(
		(process.platform === 'linux' && Boolean(process.env.APPIMAGE)) ||
		(process.platform === 'win32' && !process.windowsStore) ||
		(process.platform === 'darwin' && !process.mas)
	);

const canAutoUpdate = () => updateSettings.autoUpdate !== false;

const canSetAutoUpdate = () => !appUpdateSettings.forced || appUpdateSettings.autoUpdate !== false;

const setAutoUpdate = (canAutoUpdate) => {
	if (!canSetAutoUpdate()) {
		return;
	}

	updateSettings.autoUpdate = userUpdateSettings.autoUpdate = Boolean(canAutoUpdate);
	saveUpdateSettings();
};

const skipUpdateVersion = (version) => {
	userUpdateSettings.skip = version;
	saveUpdateSettings();
};

const downloadUpdate = () => {
	electronUpdater.autoUpdater.downloadUpdate();
};

let checkForUpdatesEvent = null;

const checkForUpdates = (e = null, { forced = false } = {}) => {
	if (checkForUpdatesEvent) {
		return;
	}

	if ((forced || canAutoUpdate()) && canUpdate()) {
		checkForUpdatesEvent = e;
		electronUpdater.autoUpdater.checkForUpdates();
	}
};

const sendToMainWindow = async(channel, ...args) => {
	const mainWindow = await getMainWindow();
	const send = () => mainWindow.send(channel, ...args);

	if (mainWindow.webContents.isLoading()) {
		mainWindow.webContents.on('dom-ready', send);
		return;
	}

	send();
};

const handleCheckingForUpdate = () => {
	sendToMainWindow('update-checking');
};

const handleUpdateAvailable = ({ version }) => {
	if (checkForUpdatesEvent) {
		checkForUpdatesEvent.sender.send('update-result', true);
		checkForUpdatesEvent = null;
	} else if (updateSettings.skip === version) {
		return;
	}

	electron.ipcMain.emit('close-about-dialog');
	electron.ipcMain.emit('open-update-dialog', undefined, { newVersion: version });
};

const handleUpdateNotAvailable = () => {
	sendToMainWindow('update-not-available');

	if (checkForUpdatesEvent) {
		checkForUpdatesEvent.sender.send('update-result', false);
		checkForUpdatesEvent = null;
	}
};

const handleUpdateDownloaded = async() => {
	const mainWindow = await getMainWindow();

	const response = electron.dialog.showMessageBox(mainWindow, {
		type: 'question',
		title: i18n.__('Update_ready'),
		message: i18n.__('Update_ready_message'),
		buttons: [
			i18n.__('Update_Install_Later'),
			i18n.__('Update_Install_Now'),
		],
		defaultId: 1,
	});

	if (response === 0) {
		electron.dialog.showMessageBox(mainWindow, {
			type: 'info',
			title: i18n.__('Update_installing_later'),
			message: i18n.__('Update_installing_later_message'),
			buttons: [i18n.__('OK')],
			defaultId: 0,
		});
		return;
	}

	mainWindow.removeAllListeners();
	electron.app.removeAllListeners('window-all-closed');
	electronUpdater.autoUpdater.quitAndInstall();
};

const handleError = async(error) => {
	sendToMainWindow('update-error', error);

	if (checkForUpdatesEvent) {
		checkForUpdatesEvent.sender.send('update-result', false);
		checkForUpdatesEvent = null;
	}
};

electronUpdater.autoUpdater.autoDownload = false;
electronUpdater.autoUpdater.on('checking-for-update', handleCheckingForUpdate);
electronUpdater.autoUpdater.on('update-available', handleUpdateAvailable);
electronUpdater.autoUpdater.on('update-not-available', handleUpdateNotAvailable);
electronUpdater.autoUpdater.on('update-downloaded', handleUpdateDownloaded);
electronUpdater.autoUpdater.on('error', handleError);

electron.ipcMain.on('can-update', (e) => { e.returnValue = canUpdate(); });
electron.ipcMain.on('can-auto-update', (e) => { e.returnValue = canAutoUpdate(); });
electron.ipcMain.on('can-set-auto-update', (e) => { e.returnValue = canSetAutoUpdate(); });
electron.ipcMain.on('set-auto-update', (e, canAutoUpdate) => setAutoUpdate(canAutoUpdate));
electron.ipcMain.on('check-for-updates', (e, ...args) => checkForUpdates(e, ...args));
electron.ipcMain.on('skip-update-version', (e, ...args) => skipUpdateVersion(...args));
electron.ipcMain.on('remind-update-later', () => {});
electron.ipcMain.on('download-update', () => downloadUpdate());

let servers = {};

var servers$1 = {
	loadServers(s) {
		servers = s;
	},

	getServers() {
		return servers;
	},
};

electron.app.on('login', function(event, webContents, request, authInfo, callback) {
	for (const url$$1 of Object.keys(servers)) {
		const server = servers[url$$1];
		if (request.url.indexOf(url$$1) === 0 && server.username) {
			callback(server.username, server.password);
			break;
		}
	}
});

process.env.GOOGLE_API_KEY = 'AIzaSyADqUh_c1Qhji3Cp1NE43YrcpuPkmhXD-c';

const unsetDefaultApplicationMenu = () => {
	if (process.platform !== 'darwin') {
		electron.Menu.setApplicationMenu(null);
		return;
	}

	const emptyMenuTemplate = [{
		label: electron.app.getName(),
		submenu: [
			{
				label: i18n.__('&Quit %s', electron.app.getName()),
				accelerator: 'CommandOrControl+Q',
				click() {
					electron.app.quit();
				},
			},
		],
	}];
	electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(emptyMenuTemplate));
};

const parseProtocolUrls = (args) =>
	args.filter((arg) => /^rocketchat:\/\/./.test(arg))
		.map((uri) => url.parse(uri))
		.map(({ hostname, pathname, query }) => {
			const { insecure } = querystring.parse(query);
			return `${ insecure === 'true' ? 'http' : 'https' }://${ hostname }${ pathname || '' }`;
		});

const addServers = (protocolUrls) => parseProtocolUrls(protocolUrls)
	.forEach((serverUrl) => addServer(serverUrl));

// macOS only
electron.app.on('open-url', (event, url$$1) => {
	event.preventDefault();
	addServers([url$$1]);
});

electron.app.on('window-all-closed', () => {
	electron.app.quit();
});

if (!electron.app.isDefaultProtocolClient('rocketchat')) {
	electron.app.setAsDefaultProtocolClient('rocketchat');
}

electron.app.setAppUserModelId('chat.rocket');
if (process.platform === 'linux') {
	electron.app.disableHardwareAcceleration();
}

electron.ipcMain.on('getSystemIdleTime', (event) => {
	event.returnValue = idle.getIdleTime();
});

process.on('unhandledRejection', console.error.bind(console));


const gotTheLock = electron.app.requestSingleInstanceLock();

if (gotTheLock) {
	electron.app.on('second-instance', async(event, argv) => {
		(await getMainWindow()).show();
		addServers(argv.slice(2));
	});

	electron.app.on('ready', async() => {
		unsetDefaultApplicationMenu();

		appData.initialize();

		const mainWindow = await getMainWindow();
		certificateStore.initWindow(mainWindow);

		electron.ipcMain.emit('check-for-updates');
	});
} else {
	electron.app.quit();
}

exports.certificate = certificateStore;
exports.dock = dock;
exports.menus = menus;
exports.tray = tray;
exports.remoteServers = servers$1;

})()
//# sourceMappingURL=background.js.map
