import path from 'path';

import { app, ipcMain } from 'electron';
import jetpack from 'fs-jetpack';


function definePath() {
	const dirName = process.env.NODE_ENV === 'production' ? app.name : `${ app.name } (${ process.env.NODE_ENV })`;

	app.setPath('userData', path.join(app.getPath('appData'), dirName));
}

async function reset() {
	const dataDir = app.getPath('userData');
	await jetpack.removeAsync(dataDir);
	app.relaunch({ args: [process.argv[1]] });
	app.quit();
}

async function migrate() {
	const olderAppName = 'Rocket.Chat+';
	const dirName = process.env.NODE_ENV === 'production' ? olderAppName : `${ olderAppName } (${ process.env.NODE_ENV })`;
	const olderUserDataPath = path.join(app.getPath('appData'), dirName);

	try {
		await jetpack.copyAsync(olderUserDataPath, app.getPath('userData'), { overwrite: true });
		await jetpack.removeAsync(olderUserDataPath);
	} catch (error) {
		if (jetpack.exists(olderUserDataPath)) {
			throw error;
		}

		console.log('No data to migrate.');
	}
}

async function initialize() {
	definePath();

	if (process.argv[2] === '--reset-app-data') {
		await reset();
		return;
	}

	await migrate();
}

ipcMain.on('reset-app-data', () => {
	app.relaunch({ args: [process.argv[1], '--reset-app-data'] });
	app.quit();
});

export default {
	initialize,
};
