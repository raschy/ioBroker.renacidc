/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
'use strict';

// Load your modules here, e.g.:
// const fs = require("fs");
const utils = require('@iobroker/adapter-core');
const api = require('./lib/apiClient.js');

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
		this.checkUserDataOk = false;
		this.executionInterval = 60;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		this.setState('info.connection', { val: false, ack: true });
		await this.checkUserData();
		//
		if (this.checkUserDataOk){
			await this.requestInverterData();
			//
			this.updateInterval = setInterval(async () => {
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
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);
			this.log.info('cleaned everything up...');
			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * requestInverterData()
	 */
	async requestInverterData(){
		this.log.info('Adapter tries to retrieve data from the cloud');
		try {
			const userId = await this.initializeStation();
			this.log.debug(`UserID: ${userId}`);
			//
			const stationIdList = await this.stationList(userId);
			//this.log.debug(`StationList: ${stationIdList}`);
			for (const stationId of stationIdList) {
				this.log.debug(`StationID: ${stationId}`);
				const deviceIdList = await this.deviceList(userId, stationId);
				//this.log.debug(`DeviceIdList: ${deviceIdList}`);
				for (const inverterSn of deviceIdList) {
					this.log.debug(`InverterSN: ${inverterSn}`);
					await this.updateData(await this.inverterData(inverterSn),userId);
					//await this.alarmList(userId);
					//await this.inverterDataHistorical(inverterSn,2,await this.calcDateYesterday());
				}
			}
			this.setState('info.connection', { val: true, ack: true });
		}
		catch (error) {
			this.setState('info.connection', { val: false, ack: true });
			this.log.debug(`[requestInverterData] catch ${JSON.stringify(error)}`);
		}
		finally {
			this.log.debug('[requestInverterData] finished');
		}
		//
	}

	/**
	 * save data in ioBroker datapoints
	 * @param {*} key
	 * @param {*} name
	 * @param {*} value
	 * @param {*} role
	 * @param {*} unit
	 */
	async persistData(user, key, name, value, role, unit) {
		const dp_Device = String(user);
		const path = dp_Device + '.';
		// Type recognition
		let type = 'string';
		if (isNumber(value)) {
			type = 'number';
			value = parseFloat(value);
		}
		if (typeof value === 'object') {
			type = 'string';
			value = JSON.stringify(value);
		}
		//console.log(`[persistData] Device "${dp_Device}"  Key "${key}" with value: "${value}" and unit "${unit}" with role "${role}" as type "${type}"`);

		await this.setObjectNotExists(dp_Device, {
			type: 'channel',
			common: {
				name: 'User ID',
				role: 'info'
			},
			native: {}
		});

		/*
		await this.extendObjectAsync(dp_Device, {
			common: {
				name: userName,
			},
		});
*/

		await this.setObjectNotExistsAsync(path + key, {
			type: 'state',
			common: {
				name: name,
				role: role,
				// @ts-ignore
				type: type,
				// @ts-ignore
				unit: unit,
				read: true,
				write: false
			},
			native: {},
		});

		await this.setStateAsync(path + key, { val: value, ack: true, q: 0x00 });
		//
		function isNumber(n) {
			return !isNaN(parseFloat(n)) && !isNaN(n - 0);
		}
	}

	/**
	 * prepare data vor ioBroker
	 * @param {*} data
	 * @param {number} user
	 */
	async updateData(data, user) {
		if (user < 1) return;
		//
		for (const key in data) {
			if (key != 'none') {
				const name = makeName(key);
				const unit = guessUnit(key);
				await this.persistData(user, key, name, data[key], 'value', unit);
			}
		}
		//
		// Regex to remove the underscore and process singlewords
		function makeName(inputString){
			return inputString.replace(/_/g, ' ').split(' ').map(capitalizeFirstLetter).join(' ');
		}
		// Function to convert the first letter of a word into capital letters
		function capitalizeFirstLetter(word) {
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		}
		//	Trying to guess the unit of measurement
		function guessUnit(inputString){
			let regex = new RegExp('vol');
			if (regex.test(inputString)) return 'V';
			regex = new RegExp('cur');
			if (regex.test(inputString)) return 'A';
			regex = new RegExp('fre');
			if (regex.test(inputString)) return 'Hz';
			regex = new RegExp('power');
			if (regex.test(inputString)) return 'W';
			regex = new RegExp('energy');
			if (regex.test(inputString)) return 'kWh';
			regex = new RegExp('capac');
			if (regex.test(inputString)) return 'AH';
			regex = new RegExp('temp');
			if (regex.test(inputString)) return '°C';
			return ' ';
		}
	}

	/**
	 * inverterDataHistorical()
	 * @param {*} inverterSN
	 * @returns
	 */
	async inverterDataHistorical(inverterSN, chartType, chartData) {
		//console.log(`[inverterDataHistorical] InverterSN: ${inverterSN}`);
		return api.axios
			.post(
				'renac/storage/equChart',			// 2.2.9
				//'renac/grid/equChart',			// 2.2.10
				{
					'inv_sn' : String(inverterSN),
					'chart_type' : chartType,		// chart_type: 1=Daily, 2,=Weekly, 3=Monthly, 4=Yearly, 5=Total
					'time' : chartData
				}
			)
			.then((response) => {
				return response.data.data;
			})
			.catch((error) => {
				this.log.warn(`[inverterDataHistorical] error: ${error.code}`);
				return Promise.reject(error);
			});
	}

	/**
	 * alarmList()
	 * @param {*} userId
	 * @returns
	 */
	async alarmList(userId) {
		//console.log(`[alarmList] UserID: ${userId}`);
		return api.axios
			.post(
				'api/home/errorList2',
				{
					'user_id' : userId,
					'begin_time' : '2023-08-01',
					'end_time' : '2023-08-31',
					'offset' : 0,
					'rows' :50
				}
			)
			.then((response) => {
				//console.log ('alarmList: ', response.data.data); //####
				/*
				for (const obj of response.data.data.list) {
					//this.deviceIdList.push(obj.INV_SN);	// DeviceId's
				}
				*/
				return response.data.data;

			})
			.catch((error) => {
				this.log.warn(`[alarmList] error: ${error.code}`);
				return Promise.reject(error);
			});
	}

	/**
	 * inverterData()
	 * @param {*} inverterSN
	 * @returns data
	 */
	async inverterData(inverterSN) {
		//console.log(`[inverterData] InverterSN: ${inverterSN}`);
		return api.axios
			.post(
				//'renac/grid/equData',		//2.2.5
				'renac/storage/equData',	//2.2.6
				{
					'equ_sn' : String(inverterSN)
				}
			)
			.then((response) => {
				//console.log ('inverterData: ', response.data.data); //####
				return response.data.data;
			})
			.catch((error) => {
				this.log.warn(`[inverterData] error: ${error.code}`);
				return Promise.reject(error);
			});
	}

	/**
	 * deviceList()
	 * @param {*} userId
	 * @param {*} stationId
	 * @returns
	 */
	async deviceList(userId, stationId) {
		//console.log(`[deviceList] UserID: ${userId} StationID: ${stationId}`);
		return api.axios
			.post(
				'bg/equList',
				{
					'user_id' : userId,
					'station_id' : stationId,
					'offset': 0,
					'rows':10
				}
			)
			.then((response) => {
				const deviceIdList =[];
				for (const obj of response.data.data.list) {
					deviceIdList.push(obj.INV_SN);	// DeviceId's
				}
				return deviceIdList;
			})
			.catch((error) => {
				this.log.warn(`[deviceList] error: ${error.code}`);
				return Promise.reject(error);
			});
	}


	/**
	 * stationList()
	 * @param {*} userId
	 * @returns stationIdList[]
	 */
	async stationList(userId) {
		//console.log(`[stationList] UserID: ${userId}`);
		return api.axios
			.post(
				'api/station/list',
				{
					'user_id' : userId,
					'offset': 0,
					'rows':10
				}
			)
			.then((response) => {
				const stationIdList =[];
				for (const obj of response.data.data.list) {
					stationIdList.push(obj.station_id);
				}
				return stationIdList;
			})
			.catch((error) => {
				this.log.warn(`[stationList] error: ${error.code}`);
				return Promise.reject(error);
			});
	}

	/**
	 * initializeStation()
	 * @returns userId
	 */
	async initializeStation() {
		//console.log(`[initializeStation]`);
		return api.axios
			.post(
				'api/user/login',
				{
					'login_name' : this.config.username,
					'pwd': this.config.password
				}
			)
			.then((response) => {
				return response.data.data;
			})
			.catch((error) => {
				this.log.error(`[initializeStation] error: ${error.message}`);
				return Promise.reject(error);
			});
	}

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
		/*
		if (!isValidInput(this.config.url, 17)) {
			this.log.warn('The URL you have entered is not text or empty - please check instance configuration.');
			this.checkUserDataOk = false;
			return;
		}
		if (!this.config.url.endsWith('/')){
			this.config.url + '/';
		}
		*/
		// __________________
		// check if the sync time is a number, if not, the string is parsed to a number
		if (isNaN(this.config.pollInterval) || this.config.pollInterval < 10) {
			this.executionInterval = 60;
		} else {
			this.executionInterval = this.config.pollInterval;
		}
		this.log.info(`Retrieving data from the inverter will be done every ${this.executionInterval} seconds`);
		//
		this.log.debug(`checkUserData is ready`);
		this.checkUserDataOk = true;
		return;
		//
		function isNonEmptyString(input) {
			// Check whether input is a string and whether not empty
			return typeof input === 'string' && input.trim() !== '';
		}
		/*
		function isValidInput(input, minLength) {
			// Check whether input is a string and whether the length is greater than or equal to the minimum length.
			return typeof input === 'string' && input.length >= minLength;
		}
		*/
	}

	/**
	 * calcDateYesterday()
	 * @returns
	 */
	async calcDateYesterday() {
		const today = new Date();
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		// Convert the date into 'yyyy-mm-dd' format
		const year = yesterday.getFullYear();
		const month = (yesterday.getMonth() + 1).toString().padStart(2, '0');
		const day = yesterday.getDate().toString().padStart(2, '0');
		return year + '-' + month + '-' + day;
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