import { shell } from 'electron';


const getSettings = () => (
	(window.RocketChat && window.RocketChat.settings) ||
		(window.require && window.require('meteor/rocketchat:settings').settings)
);

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
		shell.showItemInFolder(filePath);
		event.preventDefault();
		return;
	}

	const settings = getSettings();
	const isInsideDomain = settings && RegExp(`^${ settings.get('Site_Url') }`).test(href);
	const isRelative = !/^([a-z]+:)?\/\//.test(href);
	if (isInsideDomain || isRelative) {
		return;
	}

	shell.openExternal(href);
	event.preventDefault();
};


export default () => {
	window.addEventListener('load', () => {
		document.addEventListener('click', handleAnchorClick, true);
	});
};
