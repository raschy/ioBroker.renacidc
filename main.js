/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
//'use strict';

// Load your modules here, e.g.:
const utils = require('@iobroker/adapter-core');

class Renacidc extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'renacidc',
		});

		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		//
		this.runFirst = false;
		this.interactiveBlacklist = '';
		this.checkUserDataOk = false;
		this.executionInterval = 90;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		this.setState('info.connection', { val: false, ack: true });
		await this.checkUserData();
		this.interactiveBlacklist = this.config.deviceBlacklist;
		//
		if (this.checkUserDataOk) {
			await this.requestInverterData();
			//
			this.updateInterval = this.setInterval(async () => {
				await this.requestInverterData();
			}, this.executionInterval * 1000);
		} else {
			this.setState('info.connection', { val: false, ack: true });
			this.log.error('Adapter cannot be started without correct settings!');
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			this.updateInterval && clearInterval(this.updateInterval);
			this.log.info('cleaned everything up...');
			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * requestInverterData()
	 */
	async requestInverterData() {
		this.log.info('Adapter tries to retrieve data from the cloud');
		try {
			const userId = await this.initializeStation();
			//
			const stationIdList = await this.stationList(userId);
			for (const stationId of stationIdList) {
				await this.updateData(await this.devicePowerFlow(stationId), '', stationId);
				await this.updateDataSub(await this.deviceOverview(stationId), stationId);
				await this.updateData(await this.deviceSavings(stationId), 'saving', stationId);
				//
				const deviceIdList = await this.deviceEqulist(userId, stationId);
				for (const deviceId of deviceIdList) {
					await this.updateData(await this.deviceInvDetail(deviceId, this.dateToday()), 'inverter', stationId);
				}
			}
			this.setState('info.lastUpdate', { val: Date.now(), ack: true });
			this.setState('info.connection', { val: true, ack: true });
		}
		catch (error) {
			this.setState('info.connection', { val: false, ack: true });
			this.log.error(`[requestInverterData] catch: message ${error.message}`);
			this.log.debug(`[requestInverterData] catch: stack ${error.stack}`);
		}
		this.manageBlacklist(this.interactiveBlacklist);
		this.runFirst = true;
		//
	}

	/**
	 * save data in ioBroker datapoints
	 * @param {string} device
	 * @param {string} dp
	 * @param {string} name
	 * @param {*} value
	 * @param {string} role
	 * @param {string} unit
	 */
	async persistData(device, dp, name, value, unit, role) {
		await this.setObjectNotExists(device, {
			type: 'channel',
			common: {
				name: 'Station ID',
				desc: 'generated by renacidc',
				role: 'info'
			},
			native: {}
		});
		//
		// Type recognition <number>
		if (this.isNumber(value)) {
			value = parseFloat(value);
			//
			await this.setObjectNotExistsAsync(dp, {
				type: 'state',
				common: {
					name: name,
					type: 'number',
					role: role,
					unit: unit,
					read: true,
					write: false,
				},
				native: {},
			});
		} else { // or <string>
			await this.setObjectNotExistsAsync(dp, {
				type: 'state',
				common: {
					name: name,
					type: 'string',
					role: role,
					unit: unit,
					read: true,
					write: false,
				},
				native: {},
			});
		}
		//
		//console.log(`[persistData] Device "${device}"  DP "${dp}" with value: "${value}" and unit "${unit}" with role "${role}" as type "{type}"`);
		await this.setState(dp, { val: value, ack: true, q: 0x00 });
		//
	}
	/**
	 * prepare data vor ioBroker
	 * @param {object} data
	 * @param {string} folder
	 * @param {number} stationId
	 */
	async updateData(data, folder, stationId) {
		if (!data || stationId < 1) return;
		//
		for (const key in data) {
			let entry = '';
			const _key = this.removeInvalidCharacters(key);
			if (folder) {
				entry = this.capitalizeFirstLetter(this.removeInvalidCharacters(folder)) + '.' + _key;
			} else {
				entry = _key;
			}
			//
			const device = this.removeInvalidCharacters(String(stationId));
			const fullState = device + '.' + entry;
			//
			const result = this.config.deviceBlacklist.includes(entry);
			// Add deleted keys to the blacklist
			const currentObj = await this.getStateAsync(fullState);
			if (!result && !currentObj && this.runFirst) {
				if (this.interactiveBlacklist) {
					this.interactiveBlacklist += ', ' + entry;
				} else {
					this.interactiveBlacklist += entry;
				}
			}
			//
			if (!result && key != 'none') {
				const name = this.makeName(key);
				const stateroles = this.guessUnit(key);
				await this.persistData(device, fullState, name, data[key], stateroles.unit, stateroles.role);
			} else {
				await this.deleteDeviceState(fullState);
			}
		}
	}

	/**
	 * prepare data vor ioBroker
	 * @param {object} data
	 * @param {number} stationId
	 */
	async updateDataSub(data, stationId) {
		if (stationId < 1) return;
		//
		for (const property in data) {
			const rawData = data[property][0];
			for (const element in rawData) {
				const res = JSON.parse('{"' + this.removeInvalidCharacters(element) + '":"' + rawData[element] + '"}');
				this.updateData(res, property, stationId);
			}
		}
	}

	/**
	 * manageBlacklist
	 * @param {*} interactiveBlacklist
	 */
	async manageBlacklist(interactiveBlacklist) {
		const blacklistChanged = this.config.deviceBlacklist.localeCompare(interactiveBlacklist);
		// write into config if changes
		if (blacklistChanged < 0) {
			this.log.debug(`[manageBlacklist] ${interactiveBlacklist}`);
			this.getForeignObject('system.adapter.' + this.namespace, (err, obj) => {
				if (err) {
					this.log.error(`[manageBlacklist] ${err}`);
				} else {
					if (obj) {
						obj.native.deviceBlacklist = interactiveBlacklist; // modify object
						this.setForeignObject(obj._id, obj, (err) => {
							if (err) {
								this.log.error(`[manageBlacklist] Error while DeviceListUpdate: ${err}`);
							} else {
								this.log.debug(`[manageBlacklist] New Devicelist: ${interactiveBlacklist}`);
							}
						});
					}
				}
			});
		}
	}

	/**
	 * Data from api 'detail'
	 * @param {number} equSn
	 * @param {String} today
	 * @returns {Promise<object>} data
	 */
	async deviceInvDetail(equSn, today) {
		this.log.debug(`[deviceInvDetail] Equ SN: ${equSn} Datum: ${today}`);
		const url = this.urlBase + '/bg/inv/detail';
		//
		const body = {
			'equ_sn': equSn,
			offset: 0,
			rows: 10,
			time: today
		};
		//
		return fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json, text/plain, */*',
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
				'token': this.token,
			},
			body: JSON.stringify(body)
		}).then(async response => {
			if (!response.ok) throw new Error('[deviceInvDetail] failed to retrieve data');
			const data = await response.json();
			// @ts-ignore
			if (data.code == 1) {
				// @ts-ignore
				return data.data.im;
			} else {
				throw new Error('[deviceInvDetail] incorrect data received');
			}
		});
	}

	/**
	 * Data from api 'equList'
	 * @param {number} userId
	 * @param {number} stationId
	 * @returns {Promise<array>} DeviceIdList
	 */
	async deviceEqulist(userId, stationId) {
		this.log.debug(`[deviceEqulist] User ID: ${userId} Station ID: ${stationId}`);
		const url = this.urlBase + '/bg/equList';
		//
		const body = {
			'user_id': userId,
			'station_id': stationId,
			status: 0,
			offset: 0,
			rows: 10,
			equ_sn: ''
		};
		//
		return fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json, text/plain, */*',
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
				'token': this.token,
			},
			body: JSON.stringify(body)
		}).then(async response => {
			if (!response.ok) throw new Error('[deviceEqulist] failed to retrieve data');
			const data = await response.json();
			// @ts-ignore
			if (data.code == 1) {
				// @ts-ignore
				return data.data.list.map((item) => item.INV_SN);
			} else {
				throw new Error('[deviceEqulist] incorrect data received');
			}
		});
	}

	/**
	* Data from api 'savings'
	* @param {number} stationId
	* @returns {Promise<object>} data
	*/
	async deviceSavings(stationId) {
		this.log.debug(`[deviceSavings] Station ID: ${stationId}`);
		const url = this.urlBase + '/api/station/all/savings';
		//
		const body = {
			'station_id': stationId
		};
		//
		return fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json, text/plain, */*',
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
				'token': this.token,
			},
			body: JSON.stringify(body)
		}).then(async response => {
			if (!response.ok) throw new Error('[deviceSavings] failed to retrieve data');
			const data = await response.json();
			// @ts-ignore
			if (data.code == 1) {
				// @ts-ignore
				return data.data;
			} else {
				throw new Error('[deviceSavings] incorrect data received');
			}
		});
	}

	/**
	 * Data from api 'overview'
	 * @param {number} stationId
	 * @returns {Promise<object>} data
	 */
	async deviceOverview(stationId) {
		this.log.debug(`[deviceOverview] Station ID: ${stationId}`);
		const url = this.urlBase + '/api/station/storage/overview';
		//
		const body = {
			'station_id': stationId
		};
		//
		return fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json, text/plain, */*',
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
				'token': this.token,
			},
			body: JSON.stringify(body)
		}).then(async response => {
			if (!response.ok) throw new Error('[deviceOverview] failed to retrieve data');
			const data = await response.json();
			// @ts-ignore
			if (data.code == 1) {
				// @ts-ignore
				return data.data;
			} else {
				throw new Error('[deviceOverview] incorrect data received');
			}
		});
	}

	/**
	 * Data from api 'powerFlow'
	 * @param {number} stationId
	 * @returns {Promise<object>} data
	 */
	async devicePowerFlow(stationId) {
		this.log.debug(`[devicePowerFlow] Station ID: ${stationId}`);
		const url = this.urlBase + '/api/home/station/powerFlow';
		const params = new URLSearchParams();
		params.append('station_id', String(stationId));
		//
		return fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json, text/plain, */*',
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
				'token': this.token,
			},
			body: params.toString()
		}).then(async response => {
			if (!response.ok) throw new Error('[devicePowerFlow] failed to retrieve data');
			const data = await response.json();
			// @ts-ignore
			if (data.code == 1) {
				// @ts-ignore
				return data.data;
			} else {
				throw new Error('[devicePowerFlow] incorrect data received');
			}
		});
	}

	/**
	 * stationList[]
	 * @param {number} userId
	 * @returns {Promise<array>} stationIdList
	 */
	async stationList(userId) {
		this.log.debug(`[stationList] User ID: ${userId}`);
		const url = this.urlBase + '/api/station/list';
		//
		const body = {
			'user_id': userId,
			'offset': 0,
			'rows': 10
		};
		//
		return fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
				'token': this.token,
			},
			body: JSON.stringify(body)
		}).then(async response => {
			if (!response.ok) throw new Error('[stationList] failed to retrieve data');
			const data = await response.json();
			// @ts-ignore
			if (data.code == 1) {
				// @ts-ignore
				return data.data.list.map((item) => item.station_id);
			} else {
				throw new Error('[stationList] incorrect data received');
			}
		});
	}

	/**
	 * initializeStation (get UserID & Token)
	 * @returns {Promise<number>} userId
	 * @token
	 */
	async initializeStation() {
		this.log.debug('[initializeStation]');
		const url = this.urlBase + '/api/user/login';
		//
		const body = {
			'login_name': this.config.username,
			'pwd': this.config.password
		};
		//
		return fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
			},
			body: JSON.stringify(body)
		}).then(async response => {
			if (!response.ok) throw new Error('[initializeStation] failed to retrieve data');
			const data = await response.json();
			// @ts-ignore
			if (data.code == 1) {
				// @ts-ignore
				this.token = data.user.token;
				// @ts-ignore
				return data.data;
			} else {
				throw new Error('[initializeStation] incorrect data received');
			}
		});
	}
	//
	/**
	 * checkUserData()
	 * @returns checkUserDataOk
	 */
	async checkUserData() {
		// The adapters config (in the instance object everything under the attribute "native")
		// is accessible via this.config:
		// __________________
		// Check if credentials are not empty
		if (!isNonEmptyString(this.config.username)) {
			this.log.warn('The username you have entered is not text or empty - please check instance configuration.');
			this.checkUserDataOk = false;
			return;
		}
		//
		if (!isNonEmptyString(this.config.password)) {
			this.log.warn('The password you have entered is not text or empty - please check instance configuration.');
			this.checkUserDataOk = false;
			return;
		}
		// __________________
		// Check if url is not empty
		if (!isNonEmptyString(this.config.base) || !this.config.base.startsWith('https')) {
			this.log.warn('The URL you have entered is not ok or empty - please check instance configuration.');
			this.checkUserDataOk = false;
			return;
		} else {
			this.urlBase = this.config.base;
		}
		// __________________
		// check if the sync time is a number, if not, the string is parsed to a number
		if (isNaN(this.config.pollInterval) || this.config.pollInterval < 60) {
			this.executionInterval = 60;
		} else {
			this.executionInterval = this.config.pollInterval;
		}
		// __________________
		this.log.info(`Retrieving data from the inverter will be done every ${this.executionInterval} seconds`);
		this.log.debug(`checkUserData is ready`);
		this.checkUserDataOk = true;
		return;
		//
		function isNonEmptyString(input) {
			// Check whether input is a string and whether not empty
			return typeof input === 'string' && input.trim() !== '';
		}
	}

	/**
	 * Deletes states
	 * @param {string} stateToDelete
	 */
	async deleteDeviceState(stateToDelete) {
		try {
			// Verify that associated object exists
			const currentObj = await this.getStateAsync(stateToDelete);
			if (currentObj) {
				await this.delObjectAsync(stateToDelete);
				this.log.debug(`[deleteDeviceState] Object: (${stateToDelete})`);
			} else {
				const currentState = await this.getStateAsync(stateToDelete);
				if (currentState) {
					this.delObject(stateToDelete);
					this.log.debug(`[deleteDeviceState] State: (${stateToDelete})`);
				}
			}
		} catch (e) {
			this.log.error(`[deleteDeviceState] error ${e} while deleting: (${stateToDelete})`);
		}
	}

	// Helper
	isNumber(n) {
		return !isNaN(parseFloat(n)) && !isNaN(n - 0);
	}
	dateToday(){
		const d = new Date();
		return  [d.getFullYear(), d.getMonth()+1, d.getDate()].join('-') ;
	}
	removeInvalidCharacters(inputString) {
		const regexPattern = '[^a-zA-Z0-9]+';
		const regex = new RegExp(regexPattern, 'gu');
		return inputString.replace(regex, '_');
	}
	// Regex to remove the underscore and process singlewords
	makeName(inputString) {
		return inputString.replace(/_/g, ' ').split(' ').map(this.capitalizeFirstLetter).join(' ');
	}
	// Function to convert the first letter of a word into capital letters
	capitalizeFirstLetter(word) {
		return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
	}
	//	Trying to guess the unit of measurement
	guessUnit(inputString) {
		inputString = inputString.toLowerCase();
		let regex = new RegExp('vol');
		if (regex.test(inputString)) return { role: 'value.voltage', unit: 'V' };
		regex = new RegExp('cur');
		if (regex.test(inputString)) return { role: 'value.current', unit: 'A' };
		regex = new RegExp('fre');
		if (regex.test(inputString)) return { role: 'value', unit: 'Hz' };
		regex = new RegExp('power');
		if (regex.test(inputString)) return { role: 'value.power', unit: 'W' };
		regex = new RegExp('energy');
		if (regex.test(inputString)) return { role: 'value.energy', unit: 'kWh' };
		regex = new RegExp('capac');
		if (regex.test(inputString)) return { role: 'value', unit: '%' }; //AH
		regex = new RegExp('temp');
		if (regex.test(inputString)) return { role: 'value.temperature', unit: '°C' };
		regex = new RegExp('soc');
		if (regex.test(inputString)) return { role: 'value.fill', unit: '%' };
		regex = new RegExp('soh');
		if (regex.test(inputString)) return { role: 'value.fill', unit: '%' };
		regex = new RegExp('co2');
		if (regex.test(inputString)) return { role: 'value.fill', unit: 'kg' };
		regex = new RegExp('so2');
		if (regex.test(inputString)) return { role: 'value.fill', unit: 'kg' };
		regex = new RegExp('charge');
		if (regex.test(inputString)) return { role: 'value.energy', unit: 'kWh' };
		regex = new RegExp('meter');
		if (regex.test(inputString)) return { role: 'value.energy', unit: 'kWh' };
		regex = new RegExp('profit');
		if (regex.test(inputString)) return { role: 'value', unit: '€' };
		return { role: 'value', unit: ' ' };
	}

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Renacidc(options);
} else {
	// otherwise start the instance directly
	new Renacidc();
}