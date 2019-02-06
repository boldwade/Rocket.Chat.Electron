'use strict';

(function () {

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var electron = require('electron');
var jetpack = _interopDefault(require('fs-jetpack'));
var events = require('events');
var path = _interopDefault(require('path'));
var fs = _interopDefault(require('fs'));
var util = _interopDefault(require('util'));

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

const { remoteServers } = electron.remote.require('./background');

class Servers extends events.EventEmitter {
	constructor() {
		super();
		this.load();
		const processProtocol = this.getProtocolUrlFromProcess(electron.remote.process.argv);
		if (processProtocol) {
			this.showHostConfirmation(processProtocol);
		}
		electron.ipcRenderer.on('add-host', (e, host) => {
			if (this.hostExists(host)) {
				this.setActive(host);
			} else {
				this.showHostConfirmation(host);
			}
		});
	}

	get hosts() {
		return this._hosts;
	}

	set hosts(hosts) {
		this._hosts = hosts;
		this.save();
		return true;
	}

	get hostsKey() {
		return 'rocket.chat.hosts';
	}

	get activeKey() {
		return 'rocket.chat.currentHost';
	}

	load() {
		let hosts = localStorage.getItem(this.hostsKey);

		try {
			hosts = JSON.parse(hosts);
		} catch (e) {
			if (typeof hosts === 'string' && hosts.match(/^https?:\/\//)) {
				hosts = {};
				hosts[hosts] = {
					title: hosts,
					url: hosts,
				};
			}

			localStorage.setItem(this.hostsKey, JSON.stringify(hosts));
		}

		if (hosts === null) {
			hosts = {};
		}

		if (Array.isArray(hosts)) {
			const oldHosts = hosts;
			hosts = {};
			oldHosts.forEach(function(item) {
				item = item.replace(/\/$/, '');
				hosts[item] = {
					title: item,
					url: item,
				};
			});
			localStorage.setItem(this.hostsKey, JSON.stringify(hosts));
		}

		// Load server info from server config file
		if (Object.keys(hosts).length === 0) {
			const { app } = electron.remote;
			const userDir = jetpack.cwd(app.getPath('userData'));
			const appDir = jetpack.cwd(jetpack.path(app.getAppPath(), app.getAppPath().endsWith('.asar') ? '..' : '.'));
			const path$$1 = (userDir.find({ matching: 'servers.json', recursive: false })[0] && userDir.path('servers.json')) ||
				(appDir.find({ matching: 'servers.json', recursive: false })[0] && appDir.path('servers.json'));

			if (path$$1) {
				try {
					const result = jetpack.read(path$$1, 'json');
					if (result) {
						hosts = {};
						Object.keys(result).forEach((title) => {
							const url = result[title];
							hosts[url] = { title, url };
						});
						localStorage.setItem(this.hostsKey, JSON.stringify(hosts));
						// Assume user doesn't want sidebar if they only have one server
						if (Object.keys(hosts).length === 1) {
							localStorage.setItem('sidebar-closed', 'true');
						}
					}

				} catch (e) {
					console.error('Server file invalid');
				}
			}
		}

		this._hosts = hosts;
		remoteServers.loadServers(this._hosts);
		this.emit('loaded');
	}

	save() {
		localStorage.setItem(this.hostsKey, JSON.stringify(this._hosts));
		this.emit('saved');
	}

	get(hostUrl) {
		return this.hosts[hostUrl];
	}

	forEach(cb) {
		for (const host in this.hosts) {
			if (this.hosts.hasOwnProperty(host)) {
				cb(this.hosts[host]);
			}
		}
	}

	async validateHost(hostUrl, timeout = 5000) {
		const response = await Promise.race([
			fetch(`${ hostUrl }/api/info`),
			new Promise((resolve, reject) => setTimeout(() => reject('timeout'), timeout)),
		]);

		if (!response.ok) {
			throw 'invalid';
		}
	}

	hostExists(hostUrl) {
		const { hosts } = this;

		return !!hosts[hostUrl];
	}

	addHost(hostUrl) {
		const { hosts } = this;

		const match = hostUrl.match(/^(https?:\/\/)([^:]+):([^@]+)@(.+)$/);
		let username;
		let password;
		let authUrl;
		if (match) {
			authUrl = hostUrl;
			hostUrl = match[1] + match[4];
			username = match[2];
			password = match[3];
		}

		if (this.hostExists(hostUrl) === true) {
			this.setActive(hostUrl);
			return false;
		}

		hosts[hostUrl] = {
			title: hostUrl,
			url: hostUrl,
			authUrl,
			username,
			password,
		};
		this.hosts = hosts;

		remoteServers.loadServers(this.hosts);

		this.emit('host-added', hostUrl);

		return hostUrl;
	}

	removeHost(hostUrl) {
		const { hosts } = this;
		if (hosts[hostUrl]) {
			delete hosts[hostUrl];
			this.hosts = hosts;

			remoteServers.loadServers(this.hosts);

			if (this.active === hostUrl) {
				this.clearActive();
			}
			this.emit('host-removed', hostUrl);
		}
	}

	get active() {
		return localStorage.getItem(this.activeKey);
	}

	setActive(hostUrl) {
		let url;
		if (this.hostExists(hostUrl)) {
			url = hostUrl;
		} else if (Object.keys(this._hosts).length > 0) {
			url = Object.keys(this._hosts)[0];
		}

		if (url) {
			localStorage.setItem(this.activeKey, hostUrl);
			this.emit('active-setted', url);
			return true;
		}
		this.emit('loaded');
		return false;
	}

	restoreActive() {
		this.setActive(this.active);
	}

	clearActive() {
		localStorage.removeItem(this.activeKey);
		this.emit('active-cleared');
		return true;
	}

	setHostTitle(hostUrl, title) {
		if (title === 'Rocket.Chat' && /https?:\/\/open\.rocket\.chat/.test(hostUrl) === false) {
			title += ` - ${ hostUrl }`;
		}
		const { hosts } = this;
		hosts[hostUrl].title = title;
		this.hosts = hosts;
		this.emit('title-setted', hostUrl, title);
	}
	getProtocolUrlFromProcess(args) {
		let site = null;
		if (args.length > 1) {
			const protocolURI = args.find((arg) => arg.startsWith('rocketchat://'));
			if (protocolURI) {
				site = protocolURI.split(/\/|\?/)[2];
				if (site) {
					let scheme = 'https://';
					if (protocolURI.includes('insecure=true')) {
						scheme = 'http://';
					}
					site = scheme + site;
				}
			}
		}
		return site;
	}
	showHostConfirmation(host) {
		return electron.remote.dialog.showMessageBox({
			type: 'question',
			buttons: [i18n.__('Add'), i18n.__('Cancel')],
			defaultId: 0,
			title: i18n.__('Add_Server'),
			message: i18n.__('Add_host_to_servers', host),
		}, (response) => {
			if (response === 0) {
				this.validateHost(host)
					.then(() => this.addHost(host))
					.then(() => this.setActive(host))
					.catch(() => electron.remote.dialog.showErrorBox(i18n.__('Invalid_Host'), i18n.__('Host_not_validated', host)));
			}
		});
	}

	resetAppData() {
		const response = electron.remote.dialog.showMessageBox({
			type: 'question',
			buttons: ['Yes', 'Cancel'],
			defaultId: 1,
			title: i18n.__('Reset app data'),
			message: i18n.__('This will sign you out from all your teams and reset the app back to its ' +
				'original settings. This cannot be undone.'),
		});

		if (response !== 0) {
			return;
		}

		electron.ipcRenderer.send('reset-app-data');
	}

}

var servers = new Servers();

class WebView extends events.EventEmitter {
	constructor() {
		super();

		this.webviewParentElement = document.body;

		servers.forEach((host) => {
			this.add(host);
		});

		servers.on('host-added', (hostUrl) => {
			this.add(servers.get(hostUrl));
		});

		servers.on('host-removed', (hostUrl) => {
			this.remove(hostUrl);
		});

		servers.on('active-setted', (hostUrl) => {
			this.setActive(hostUrl);
		});

		servers.on('active-cleared', (hostUrl) => {
			this.deactiveAll(hostUrl);
		});

		servers.once('loaded', () => {
			this.loaded();
		});

		electron.ipcRenderer.on('screenshare-result', (e, id) => {
			const webviewObj = this.getActive();
			webviewObj.executeJavaScript(`
				window.parent.postMessage({ sourceId: '${ id }' }, '*');
			`);
		});
	}

	loaded() {
		document.querySelector('.app-page').classList.remove('app-page--loading');
	}

	loading() {
		document.querySelector('.app-page').classList.add('app-page--loading');
	}

	add(host) {
		let webviewObj = this.getByUrl(host.url);
		if (webviewObj) {
			return;
		}

		webviewObj = document.createElement('webview');
		webviewObj.setAttribute('server', host.url);
		webviewObj.setAttribute('preload', '../preload.js');
		webviewObj.setAttribute('allowpopups', 'on');
		webviewObj.setAttribute('disablewebsecurity', 'on');

		webviewObj.addEventListener('did-navigate-in-page', (lastPath) => {
			if ((lastPath.url).includes(host.url)) {
				this.saveLastPath(host.url, lastPath.url);
			}
		});

		webviewObj.addEventListener('console-message', (e) => {
			console.log('webview:', e.message);
		});

		webviewObj.addEventListener('ipc-message', (event) => {
			this.emit(`ipc-message-${ event.channel }`, host.url, event.args);

			switch (event.channel) {
				case 'title-changed':
					servers.setHostTitle(host.url, event.args[0]);
					break;
				case 'unread-changed':
					sidebar.setBadge(host.url, event.args[0]);
					break;
				case 'focus':
					servers.setActive(host.url);
					break;
				case 'get-sourceId':
					electron.ipcRenderer.send('open-screenshare-dialog');
					break;
				case 'reload-server':
					const active = this.getActive();
					const server = active.getAttribute('server');
					this.loading();
					active.loadURL(server);
					break;
				case 'sidebar-background':
					sidebar.changeSidebarColor(event.args[0]);
					break;
			}
		});

		webviewObj.addEventListener('dom-ready', () => {
			webviewObj.classList.add('ready');
			this.emit('dom-ready', host.url);
		});

		webviewObj.addEventListener('did-fail-load', (e) => {
			if (e.isMainFrame) {
				webviewObj.loadURL(`file://${ __dirname }/loading-error.html`);
			}
		});

		webviewObj.addEventListener('did-get-response-details', (e) => {
			if (e.resourceType === 'mainFrame' && e.httpResponseCode >= 500) {
				webviewObj.loadURL(`file://${ __dirname }/loading-error.html`);
			}
		});

		this.webviewParentElement.appendChild(webviewObj);

		webviewObj.src = host.lastPath || host.url;
	}

	remove(hostUrl) {
		const el = this.getByUrl(hostUrl);
		if (el) {
			el.remove();
		}
	}

	saveLastPath(hostUrl, lastPathUrl) {
		const { hosts } = servers;
		hosts[hostUrl].lastPath = lastPathUrl;
		servers.hosts = hosts;
	}

	getByUrl(hostUrl) {
		return this.webviewParentElement.querySelector(`webview[server="${ hostUrl }"]`);
	}

	getActive() {
		return document.querySelector('webview.active');
	}

	isActive(hostUrl) {
		return !!this.webviewParentElement.querySelector(`webview.active[server="${ hostUrl }"]`);
	}

	deactiveAll() {
		let item;
		while (!(item = this.getActive()) === false) {
			item.classList.remove('active');
		}
		document.querySelector('.landing-page').classList.add('hide');
	}

	showLanding() {
		this.loaded();
		document.querySelector('.landing-page').classList.remove('hide');
	}

	setActive(hostUrl) {
		if (this.isActive(hostUrl)) {
			return;
		}

		this.deactiveAll();
		const item = this.getByUrl(hostUrl);
		if (item) {
			item.classList.add('active');
		}
		this.focusActive();
	}

	focusActive() {
		const active = this.getActive();
		if (active) {
			active.focus();
			return true;
		}
		return false;
	}

	goBack() {
		this.getActive().goBack();
	}

	goForward() {
		this.getActive().goForward();
	}
}

var webview = new WebView();

class SideBar extends events.EventEmitter {
	constructor() {
		super();

		this.sortOrder = JSON.parse(localStorage.getItem(this.sortOrderKey)) || [];
		localStorage.setItem(this.sortOrderKey, JSON.stringify(this.sortOrder));

		this.listElement = document.getElementById('sidebar__servers');

		Object.values(servers.hosts)
			.sort((a, b) => this.sortOrder.indexOf(a.url) - this.sortOrder.indexOf(b.url))
			.forEach((host) => {
				this.add(host);
			});

		servers.on('host-added', (hostUrl) => {
			this.add(servers.get(hostUrl));
		});

		servers.on('host-removed', (hostUrl) => {
			this.remove(hostUrl);
		});

		servers.on('active-setted', (hostUrl) => {
			this.setActive(hostUrl);
		});

		servers.on('active-cleared', (hostUrl) => {
			this.deactiveAll(hostUrl);
		});

		servers.on('title-setted', (hostUrl, title) => {
			this.setLabel(hostUrl, title);
		});

		webview.on('dom-ready', (hostUrl) => {
			this.setActive(localStorage.getItem(servers.activeKey));
			webview.getActive().send('request-sidebar-color');
			this.setImage(hostUrl);
			if (this.isHidden()) {
				this.hide();
			} else {
				this.show();
			}
		});

	}

	get sortOrderKey() {
		return 'rocket.chat.sortOrder';
	}

	add(host) {
		let name = host.title.replace(/^https?:\/\/(?:www\.)?([^\/]+)(.*)/, '$1');
		name = name.split('.');
		name = name[0][0] + (name[1] ? name[1][0] : '');
		name = name.toUpperCase();

		const initials = document.createElement('span');
		initials.innerHTML = name;

		const tooltip = document.createElement('div');
		tooltip.classList.add('tooltip');
		tooltip.innerHTML = host.title;

		const badge = document.createElement('div');
		badge.classList.add('badge');

		const img = document.createElement('img');
		img.onload = function() {
			img.style.display = 'initial';
			initials.style.display = 'none';
		};

		let hostOrder = 0;
		if (this.sortOrder.includes(host.url)) {
			hostOrder = this.sortOrder.indexOf(host.url) + 1;
		} else {
			hostOrder = this.sortOrder.length + 1;
			this.sortOrder.push(host.url);
		}

		const hotkey = document.createElement('div');
		hotkey.classList.add('name');
		if (process.platform === 'darwin') {
			hotkey.innerHTML = `⌘${ hostOrder }`;
		} else {
			hotkey.innerHTML = `^${ hostOrder }`;
		}

		const item = document.createElement('li');
		item.appendChild(initials);
		item.appendChild(tooltip);
		item.appendChild(badge);
		item.appendChild(img);
		item.appendChild(hotkey);

		item.dataset.host = host.url;
		item.dataset.sortOrder = hostOrder;
		item.setAttribute('server', host.url);
		item.classList.add('instance');

		item.setAttribute('draggable', true);

		item.ondragstart = (event) => {
			window.dragged = event.target.nodeName !== 'LI' ? event.target.closest('li') : event.target;
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.dropEffect = 'move';
			event.target.style.opacity = .5;
		};

		item.ondragover = (event) => {
			event.preventDefault();
		};

		item.ondragenter = (event) => {
			if (this.isBefore(window.dragged, event.target)) {
				event.currentTarget.parentNode.insertBefore(window.dragged, event.currentTarget);
			} else if (event.currentTarget !== event.currentTarget.parentNode.lastChild) {
				event.currentTarget.parentNode.insertBefore(window.dragged, event.currentTarget.nextSibling);
			} else {
				event.currentTarget.parentNode.appendChild(window.dragged);
			}
		};

		item.ondragend = (event) => {
			event.target.style.opacity = '';
		};

		item.ondrop = (event) => {
			event.preventDefault();

			const newSortOrder = [];
			Array.from(event.currentTarget.parentNode.children)
				.map((sideBarElement) => {
					const url = sideBarElement.dataset.host;
					newSortOrder.push(url);
					this.remove(url);

					return sideBarElement;
				})
				.forEach((sideBarElement) => {
					this.sortOrder = newSortOrder;
					localStorage.setItem(this.sortOrderKey, JSON.stringify(this.sortOrder));

					const url = sideBarElement.dataset.host;
					const host = { url, title: sideBarElement.querySelector('div.tooltip').innerHTML };
					this.add(host);
					this.setImage(url);
				});

			this.setActive(window.dragged.dataset.host);
		};

		item.onclick = () => {
			servers.setActive(host.url);
		};

		this.listElement.appendChild(item);
		this.emit('hosts-sorted');
	}

	setImage(hostUrl) {
		const img = this.getByUrl(hostUrl).querySelector('img');
		img.src = `${ hostUrl.replace(/\/$/, '') }/assets/favicon.svg?v=${ Math.round(Math.random() * 10000) }`;
	}

	remove(hostUrl) {
		const el = this.getByUrl(hostUrl);
		if (el) {
			el.remove();
		}
	}

	getByUrl(hostUrl) {
		return this.listElement.querySelector(`.instance[server="${ hostUrl }"]`);
	}

	getActive() {
		return this.listElement.querySelector('.instance.active');
	}

	isActive(hostUrl) {
		return !!this.listElement.querySelector(`.instance.active[server="${ hostUrl }"]`);
	}

	changeSidebarColor({ color, background }) {
		const sidebar = document.querySelector('.sidebar');
		if (sidebar) {
			sidebar.style.background = background;
			sidebar.style.color = color;
		}
	}

	setActive(hostUrl) {
		if (this.isActive(hostUrl)) {
			return;
		}

		this.deactiveAll();
		const item = this.getByUrl(hostUrl);
		if (item) {
			item.classList.add('active');
		}
		if (webview.getActive() && webview.getActive().classList.contains('ready')) {
			webview.getActive().send('request-sidebar-color');
		}
	}

	deactiveAll() {
		let item;
		while (!(item = this.getActive()) === false) {
			item.classList.remove('active');
		}
	}

	setLabel(hostUrl, label) {
		this.listElement.querySelector(`.instance[server="${ hostUrl }"] .tooltip`).innerHTML = label;
	}

	setBadge(hostUrl, badge) {
		const item = this.getByUrl(hostUrl);
		const badgeEl = item.querySelector('.badge');

		if (badge !== null && badge !== undefined && badge !== '') {
			item.classList.add('unread');
			if (isNaN(parseInt(badge))) {
				badgeEl.innerHTML = '';
			} else {
				badgeEl.innerHTML = badge;
			}
		} else {
			badge = undefined;
			item.classList.remove('unread');
			badgeEl.innerHTML = '';
		}
		this.emit('badge-setted', hostUrl, badge);
	}

	getGlobalBadge() {
		let count = 0;
		let title = '';
		const instanceEls = this.listElement.querySelectorAll('li.instance');
		for (let i = instanceEls.length - 1; i >= 0; i--) {
			const instanceEl = instanceEls[i];
			const text = instanceEl.querySelector('.badge').innerHTML;
			if (!isNaN(parseInt(text))) {
				count += parseInt(text);
			}
			if (title === '' && instanceEl.classList.contains('unread') === true) {
				title = '•';
			}
		}
		if (count > 0) {
			title = count.toString();
		}
		return {
			count,
			title,
			showAlert: (title !== ''),
		};
	}

	hide() {
		document.querySelector('.sidebar').classList.add('sidebar--hidden');
		localStorage.setItem('sidebar-closed', 'true');
		this.emit('hide');
		if (process.platform === 'darwin') {
			document.querySelectorAll('webview').forEach(
				(webviewObj) => { if (webviewObj.insertCSS) { webviewObj.insertCSS('aside.side-nav{margin-top:15px;overflow:hidden; transition: margin .5s ease-in-out; } .sidebar{padding-top:10px;transition: margin .5s ease-in-out;}'); } });
		}
	}

	show() {
		document.querySelector('.sidebar').classList.remove('sidebar--hidden');
		localStorage.setItem('sidebar-closed', 'false');
		this.emit('show');
		if (process.platform === 'darwin') {
			document.querySelectorAll('webview').forEach(
				(webviewObj) => { if (webviewObj.insertCSS) { webviewObj.insertCSS('aside.side-nav{margin-top:0; overflow:hidden; transition: margin .5s ease-in-out;} .sidebar{padding-top:0;transition: margin .5s ease-in-out;}'); } });
		}
	}

	toggle() {
		if (this.isHidden()) {
			this.show();
		} else {
			this.hide();
		}
	}

	isHidden() {
		return localStorage.getItem('sidebar-closed') === 'true';
	}

	isBefore(a, b) {
		if (a.parentNode === b.parentNode) {
			for (let cur = a; cur; cur = cur.previousSibling) {
				if (cur === b) {
					return true;
				}
			}
		}
		return false;
	}
}

var sidebar = new SideBar();


let selectedInstance = null;
const instanceMenu = electron.remote.Menu.buildFromTemplate([{
	label: i18n.__('Reload_server'),
	click() {
		webview.getByUrl(selectedInstance.dataset.host).reload();
	},
}, {
	label: i18n.__('Remove_server'),
	click() {
		servers.removeHost(selectedInstance.dataset.host);
	},
}, {
	label: i18n.__('Open DevTools'),
	click() {
		webview.getByUrl(selectedInstance.dataset.host).openDevTools();
	},
}]);

window.addEventListener('contextmenu', function(e) {
	if (e.target.classList.contains('instance') || e.target.parentNode.classList.contains('instance')) {
		e.preventDefault();
		if (e.target.classList.contains('instance')) {
			selectedInstance = e.target;
		} else {
			selectedInstance = e.target.parentNode;
		}

		instanceMenu.popup(electron.remote.getCurrentWindow());
	}
}, false);

if (process.platform === 'darwin') {
	window.addEventListener('keydown', function(e) {
		if (e.key === 'Meta') {
			document.getElementsByClassName('sidebar')[0].classList.add('command-pressed');
		}
	});

	window.addEventListener('keyup', function(e) {
		if (e.key === 'Meta') {
			document.getElementsByClassName('sidebar')[0].classList.remove('command-pressed');
		}
	});
} else {
	window.addEventListener('keydown', function(e) {
		if (e.key === 'ctrlKey') {
			document.getElementsByClassName('sidebar')[0].classList.add('command-pressed');
		}
	});

	window.addEventListener('keyup', function(e) {
		if (e.key === 'ctrlKey') {
			document.getElementsByClassName('sidebar')[0].classList.remove('command-pressed');
		}
	});
}

const { TouchBar, nativeImage, getCurrentWindow } = electron.remote;
const { TouchBarButton, TouchBarLabel, TouchBarSegmentedControl, TouchBarScrubber, TouchBarPopover, TouchBarGroup } = TouchBar;

class SelectServerPanel {
	constructor() {
		this._MAX_LENGTH_FOR_SEGMENTS_CONTROL = 76 - i18n.__('Select_server').length;
		this._hosts = [];

		this._setHostsArray();
		this._subscribe();
	}

	_isSegmentedControl() {
		return this.control && this.control.hasOwnProperty('selectedIndex');
	}

	_getActiveServerIndex() {
		return this._hosts.findIndex((value) => value.host === servers.active);
	}

	_setActiveServer() {
		if (this._isSegmentedControl()) {
			this.control.selectedIndex = this._getActiveServerIndex();
		} else {
			this._update();
		}
	}

	_setHostsArray() {
		this._hosts = Object.values(servers.hosts).map((value) => ({ label: value.title, host: value.url }));
		this._hosts = this._trimHostsNames(this._hosts);
	}

	_getTotalLengthOfHostsNames() {
		return this._hosts.reduce((acc, host) => acc + host.label.length, 0);
	}

	_update() {
		this._setHostsArray();
		if (this.control) {
			if (this._isSegmentedControl()) {
				this.control.segments = this._hosts;
			} else {
				this.control.items = this._hosts;
			}
		} else {
			this.build();
		}
	}

	build() {
		const popoverItems = this._buildSelectServersPopoverItems();

		this.touchBarPopover = new TouchBarPopover({
			label: i18n.__('Select_server'),
			items: new TouchBar({
				items: popoverItems,
			}),
		});
		return this.touchBarPopover;
	}

	_buildSelectServersPopoverItems() {
		const items = [
			new TouchBarLabel({ label: i18n.__('Select_server') }),
		];

		// The maximum length of available display area is limited. If exceed the length of displayed data, then
		// touchbar element is not displayed. If the length of displayed host names exceeds the limit, then
		// the touchBarScrubber is used. In other case SegmentedControl is used.
		const hostsNamesLength = this._getTotalLengthOfHostsNames();

		if (this._hosts.length) {
			if (hostsNamesLength <= this._MAX_LENGTH_FOR_SEGMENTS_CONTROL) {
				items.push(this._buildTouchBarSegmentedControl());
			} else {
				items.push(this._buildTouchBarScrubber());
			}
		}
		return items;
	}

	_buildTouchBarSegmentedControl() {
		this.control = new TouchBarSegmentedControl({
			segmentStyle: 'separated',
			selectedIndex: this._getActiveServerIndex(),
			segments: this._hosts,
			change: (index) => {
				servers.setActive(this._hosts[index].host);
			},
		});
		return this.control;
	}

	_buildTouchBarScrubber() {
		this.control = new TouchBarScrubber({
			selectedStyle: 'background',
			showArrowButtons: true,
			mode: 'fixed',
			items: this._hosts,
			highlight: (index) => {
				servers.setActive(this._hosts[index].host);
			},
		});
		return this.control;
	}

	_subscribe() {
		servers.on('active-setted', () => this._setActiveServer());
		servers.on('host-added', () => this._update());
		servers.on('host-removed', () => this._update());
		servers.on('title-setted', () => this._update());
	}

	/**
	 * If it is possible to fit the hosts names to the specific limit, then trim the hosts names to the format "open.rocke.."
	 * @param arr {Array} array of hosts
	 * @returns {Array} array of hosts
	 */
	_trimHostsNames(arr) {
		const hostsNamesLength = this._getTotalLengthOfHostsNames();

		if (hostsNamesLength <= this._MAX_LENGTH_FOR_SEGMENTS_CONTROL) {
			return arr;
		}

		// The total length of hosts names with reserved space for '..' characters
		const amountOfCharsToDisplay = this._MAX_LENGTH_FOR_SEGMENTS_CONTROL - 2 * arr.length;
		const amountOfCharsPerHost = Math.floor(amountOfCharsToDisplay / arr.length);

		if (amountOfCharsPerHost > 0) {
			let additionChars = amountOfCharsToDisplay % arr.length;
			return arr.map((host) => {
				if (amountOfCharsPerHost < host.label.length) {
					let additionChar = 0;
					if (additionChars) {
						additionChar = 1;
						additionChars--;
					}
					host.label = `${ host.label.slice(0, amountOfCharsPerHost + additionChar) }..`;
				}
				return host;
			});
		}
		return arr;
	}
}

class FormattingPanel {
	constructor() {
		this._buttonClasses = ['bold', 'italic', 'strike', 'code', 'multi-line'];
		this._BACKGROUND_COLOR = '#A4A4A4';
	}

	build() {
		const formatButtons = [];

		this._buttonClasses.forEach((buttonClass) => {
			const touchBarButton = new TouchBarButton({
				backgroundColor: this._BACKGROUND_COLOR,
				icon: nativeImage.createFromPath(`${ __dirname }/images/icon-${ buttonClass }.png`),
				click: () => {
					webview.getActive().executeJavaScript(`
						var svg = document.querySelector("button svg[class$='${ buttonClass }']");
						svg && svg.parentNode.click();
						`.trim());
				},
			});
			formatButtons.push(touchBarButton);
		});

		this._touchBarGroup = new TouchBarGroup({
			items: [
				new TouchBarLabel({ label: i18n.__('Formatting') }),
				...formatButtons,
			],
		});
		return this._touchBarGroup;
	}
}

class TouchBarBuilder {
	constructor() {
		this._touchBarElements = {};
	}

	build() {
		this._touchBar = new TouchBar({
			items: Object.values(this._touchBarElements).map((element) => element.build()),
		});
		return this._touchBar;
	}

	addSelectServerPanel(panel) {
		if (this._isPanel(panel)) {
			this._touchBarElements.selectServerPanel = panel;
		}
		return this;
	}

	addFormattingPanel(panel) {
		if (this._isPanel(panel)) {
			this._touchBarElements.formattingtPanel = panel;
		}
		return this;
	}

	_isPanel(panel) {
		return panel && typeof panel.build === 'function';
	}
}

function setTouchBar() {
	servers.once('active-setted', () => {
		const touchBar = new TouchBarBuilder()
			.addSelectServerPanel(new SelectServerPanel())
			.addFormattingPanel(new FormattingPanel())
			.build();
		getCurrentWindow().setTouchBar(touchBar);
	});
}

const { app, getCurrentWindow: getCurrentWindow$1, shell } = electron.remote;
const { certificate, dock, menus, tray } = electron.remote.require('./background');

const updatePreferences = () => {
	const mainWindow = getCurrentWindow$1();

	menus.setState({
		showTrayIcon: localStorage.getItem('hideTray') ?
			localStorage.getItem('hideTray') !== 'true' : (process.platform !== 'linux'),
		showUserStatusInTray: (localStorage.getItem('showUserStatusInTray') || 'true') === 'true',
		showFullScreen: mainWindow.isFullScreen(),
		showWindowOnUnreadChanged: localStorage.getItem('showWindowOnUnreadChanged') === 'true',
		showMenuBar: localStorage.getItem('autohideMenu') !== 'true',
		showServerList: localStorage.getItem('sidebar-closed') !== 'true',
	});

	tray.setState({
		showIcon: localStorage.getItem('hideTray') ?
			localStorage.getItem('hideTray') !== 'true' : (process.platform !== 'linux'),
		showUserStatus: (localStorage.getItem('showUserStatusInTray') || 'true') === 'true',
	});
};


const updateServers = () => {
	menus.setState({
		servers: Object.values(servers.hosts)
			.sort((a, b) => (sidebar ? (sidebar.sortOrder.indexOf(a.url) - sidebar.sortOrder.indexOf(b.url)) : 0))
			.map(({ title, url }) => ({ title, url })),
		currentServerUrl: servers.active,
	});
};


const updateWindowState = () => tray.setState({ isMainWindowVisible: getCurrentWindow$1().isVisible() });

const destroyAll = () => {
	try {
		menus.removeAllListeners();
		tray.destroy();
		dock.destroy();
		const mainWindow = getCurrentWindow$1();
		mainWindow.removeListener('hide', updateWindowState);
		mainWindow.removeListener('show', updateWindowState);
	} catch (error) {
		electron.remote.getGlobal('console').error(error);
	}
};

var attachEvents = () => {
	window.addEventListener('beforeunload', destroyAll);

	menus.on('quit', () => app.quit());
	menus.on('about', () => electron.ipcRenderer.send('open-about-dialog'));
	menus.on('open-url', (url) => shell.openExternal(url));

	menus.on('add-new-server', () => {
		getCurrentWindow$1().show();
		servers.clearActive();
		webview.showLanding();
	});

	menus.on('select-server', ({ url }) => {
		getCurrentWindow$1().show();
		servers.setActive(url);
	});

	menus.on('reload-server', ({ ignoringCache = false, clearCertificates = false } = {}) => {
		if (clearCertificates) {
			certificate.clear();
		}

		const activeWebview = webview.getActive();
		if (!activeWebview) {
			return;
		}

		if (ignoringCache) {
			activeWebview.reloadIgnoringCache();
			return;
		}

		activeWebview.reload();
	});

	menus.on('open-devtools-for-server', () => {
		const activeWebview = webview.getActive();
		if (activeWebview) {
			activeWebview.openDevTools();
		}
	});

	menus.on('go-back', () => webview.goBack());
	menus.on('go-forward', () => webview.goForward());

	menus.on('reload-app', () => getCurrentWindow$1().reload());

	menus.on('toggle-devtools', () => getCurrentWindow$1().toggleDevTools());

	menus.on('reset-app-data', () => servers.resetAppData());

	menus.on('toggle', (property) => {
		switch (property) {
			case 'showTrayIcon': {
				const previousValue = localStorage.getItem('hideTray') !== 'true';
				const newValue = !previousValue;
				localStorage.setItem('hideTray', JSON.stringify(!newValue));
				break;
			}

			case 'showUserStatusInTray': {
				const previousValue = (localStorage.getItem('showUserStatusInTray') || 'true') === 'true';
				const newValue = !previousValue;
				localStorage.setItem('showUserStatusInTray', JSON.stringify(newValue));
				break;
			}

			case 'showFullScreen': {
				const mainWindow = getCurrentWindow$1();
				mainWindow.setFullScreen(!mainWindow.isFullScreen());
				break;
			}

			case 'showWindowOnUnreadChanged': {
				const previousValue = localStorage.getItem('showWindowOnUnreadChanged') === 'true';
				const newValue = !previousValue;
				localStorage.setItem('showWindowOnUnreadChanged', JSON.stringify(newValue));
				break;
			}

			case 'showMenuBar': {
				const previousValue = localStorage.getItem('autohideMenu') !== 'true';
				const newValue = !previousValue;
				localStorage.setItem('autohideMenu', JSON.stringify(!newValue));
				break;
			}

			case 'showServerList': {
				sidebar.toggle();
				break;
			}
		}

		updatePreferences();
	});

	servers.on('loaded', updateServers);
	servers.on('active-cleared', updateServers);
	servers.on('active-setted', updateServers);
	servers.on('host-added', updateServers);
	servers.on('host-removed', updateServers);
	servers.on('title-setted', updateServers);
	sidebar.on('hosts-sorted', updateServers);

	sidebar.on('badge-setted', () => {
		const badge = sidebar.getGlobalBadge();
		tray.setState({ badge });
		dock.setState({ badge });
	});

	getCurrentWindow$1().on('hide', updateWindowState);
	getCurrentWindow$1().on('show', updateWindowState);

	tray.on('created', () => getCurrentWindow$1().emit('set-state', { hideOnClose: true }));
	tray.on('destroyed', () => getCurrentWindow$1().emit('set-state', { hideOnClose: false }));
	tray.on('set-main-window-visibility', (visible) =>
		(visible ? getCurrentWindow$1().show() : getCurrentWindow$1().hide()));
	tray.on('quit', () => app.quit());


	webview.on('ipc-message-unread-changed', (hostUrl, [count]) => {
		if (typeof count === 'number' && localStorage.getItem('showWindowOnUnreadChanged') === 'true') {
			const mainWindow = electron.remote.getCurrentWindow();
			if (!mainWindow.isFocused()) {
				mainWindow.once('focus', () => mainWindow.flashFrame(false));
				mainWindow.showInactive();
				mainWindow.flashFrame(true);
			}
		}
	});

	webview.on('ipc-message-user-status-manually-set', (hostUrl, [status]) => {
		tray.setState({ status });
		dock.setState({ status });
	});

	if (process.platform === 'darwin') {
		setTouchBar();
	}


	servers.restoreActive();
	updatePreferences();
	updateServers();
	updateWindowState();

};

const start = function() {
	const defaultInstance = 'https://open.rocket.chat';

	// connection check
	function online() {
		document.body.classList.remove('offline');
	}

	function offline() {
		document.body.classList.add('offline');
	}

	if (!navigator.onLine) {
		offline();
	}

	window.addEventListener('online', online);
	window.addEventListener('offline', offline);
	// end connection check

	const form = document.querySelector('form');
	const hostField = form.querySelector('[name="host"]');
	const button = form.querySelector('[type="submit"]');
	const invalidUrl = form.querySelector('#invalidUrl');

	window.addEventListener('load', () => hostField.focus());

	window.addEventListener('focus', () => webview.focusActive());

	function validateHost() {
		return new Promise(function(resolve, reject) {
			const execValidation = function() {
				invalidUrl.style.display = 'none';
				hostField.classList.remove('wrong');

				const host = hostField.value.trim();
				hostField.value = host;

				if (host.length === 0) {
					button.value = i18n.__('Connect');
					button.disabled = false;
					resolve();
					return;
				}

				button.value = i18n.__('Validating');
				button.disabled = true;

				servers.validateHost(host, 2000).then(function() {
					button.value = i18n.__('Connect');
					button.disabled = false;
					resolve();
				}, function(status) {
					// If the url begins with HTTP, mark as invalid
					if (/^https?:\/\/.+/.test(host) || status === 'basic-auth') {
						button.value = i18n.__('Invalid_url');
						invalidUrl.style.display = 'block';
						switch (status) {
							case 'basic-auth':
								invalidUrl.innerHTML = i18n.__('Auth_needed_try', '<b>username:password@host</b>');
								break;
							case 'invalid':
								invalidUrl.innerHTML = i18n.__('No_valid_server_found');
								break;
							case 'timeout':
								invalidUrl.innerHTML = i18n.__('Timeout_trying_to_connect');
								break;
						}
						hostField.classList.add('wrong');
						reject();
						return;
					}

					// // If the url begins with HTTPS, fallback to HTTP
					// if (/^https:\/\/.+/.test(host)) {
					//     hostField.value = host.replace('https://', 'http://');
					//     return execValidation();
					// }

					// If the url isn't localhost, don't have dots and don't have protocol
					// try as a .rocket.chat subdomain
					if (!/(^https?:\/\/)|(\.)|(^([^:]+:[^@]+@)?localhost(:\d+)?$)/.test(host)) {
						hostField.value = `https://${ host }.rocket.chat`;
						return execValidation();
					}

					// If the url don't start with protocol try HTTPS
					if (!/^https?:\/\//.test(host)) {
						hostField.value = `https://${ host }`;
						return execValidation();
					}
				});
			};
			execValidation();
		});
	}

	hostField.addEventListener('blur', function() {
		validateHost().then(function() {}, function() {});
	});

	electron.ipcRenderer.on('certificate-reload', function(event, url) {
		hostField.value = url.replace(/\/api\/info$/, '');
		validateHost().then(function() {}, function() {});
	});

	const submit = function() {
		validateHost().then(function() {
			const input = form.querySelector('[name="host"]');
			let url = input.value;

			if (url.length === 0) {
				url = defaultInstance;
			}

			url = servers.addHost(url);
			if (url !== false) {
				sidebar.show();
				servers.setActive(url);
			}

			input.value = '';
		}, function() {});
	};

	hostField.addEventListener('keydown', function(ev) {
		if (ev.which === 13) {
			ev.preventDefault();
			ev.stopPropagation();
			submit();
			return false;
		}
	});

	form.addEventListener('submit', function(ev) {
		ev.preventDefault();
		ev.stopPropagation();
		submit();
		return false;
	});

	document.querySelector('.add-server').addEventListener('click', () => {
		servers.clearActive();
		webview.showLanding();
	});

	document.addEventListener('click', (event) => {
		const anchorElement = event.target.closest('a[rel="noopener noreferrer"]');
		if (anchorElement) {
			electron.shell.openExternal(anchorElement.href);
			event.preventDefault();
		}
	});

	attachEvents();
};

start();

})()
//# sourceMappingURL=app.js.map
