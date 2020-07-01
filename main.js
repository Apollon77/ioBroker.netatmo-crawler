'use strict';

/*
 * Created with @iobroker/create-adapter v1.26.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const url = require('url');
const moment = require('moment');
const request = require('request');

let logger;

// Load your modules here, e.g.:
// const fs = require('fs');

class NetatmoCrawler extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'netatmo-crawler',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        logger = this.log;

        // The adapters config (in the instance object everything under the attribute 'native') is accessible via
        // this.config:
        this.log.info('config station1: ' + this.config.station1);
        this.log.info('config station2: ' + this.config.station2);
        this.log.info('config station3: ' + this.config.station3);
        this.log.info('config station4: ' + this.config.station4);
        this.log.debug('Debug message');

        let token = await this.getAuthorizationToken();
        const checkUrl = 'https://weathermap.netatmo.com/';
        if (this.config.station1 && this.config.station1.startsWith(checkUrl)) {
            await this.getStationData(1, this.config.station1, token);
        }
        if (this.config.station2 && this.config.station2.startsWith(checkUrl)) {
            await this.getStationData(2, this.config.station2, token);
        }
        if (this.config.station3 && this.config.station3.startsWith(checkUrl)) {
            await this.getStationData(3, this.config.station3, token);
        }
        if (this.config.station4 && this.config.station4.startsWith(checkUrl)) {
            await this.getStationData(4, this.config.station4, token);
        }

        this.log.debug("all done, exiting");
        this.terminate ? this.terminate(0) : process.exit(0);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);

            callback();
        } catch (e) {
            callback();
        }
    }


    async getStationData(id, url, token) {
        logger.info('Going to get information for station: ' + id);
        let stationid = this.getStationId(url);
        let stationData = await this.getPublicData(stationid, token);
        if (!stationData) {
            logger.debug('Got no station data. Trying again');
            await this.sleep(1000);
            stationData = await this.getPublicData(stationid, token);
        }
        if (stationData && stationData.measures) {
            logger.debug('Saving station data for station: ' + id);
            await this.saveStationData(id, stationData);

            const measureTypes = ['temperature', 'rain', 'pressure', 'humidity', 'windangle', 'guststrength', 'windstrength'];

            for (const measure of measureTypes) {
                if (this.hasMeasure(stationData.measures, measure)) {
                    logger.debug('Saving data for station: ' + id + ' and measure: ' + measure);
                    if (measure === 'windangle') {
                        await this.saveMeasure(id, measure, this.getWindrichtungsName(this.getMeasureValue(stationData.measures, measure)));
                    } else {
                        await this.saveMeasure(id, measure, this.getMeasureValue(stationData.measures, measure));
                    }

                    if (measure === 'rain') {
                        let rainToday = await this.getRainToday(stationData.measures, stationid, token);
                        if (!rainToday) {
                            await this.sleep(1000);
                            rainToday = await this.getRainToday(stationData.measures, stationid, token);
                        }
                        await this.saveMeasure(id, 'rain_today', rainToday);
                        logger.debug('Saved rain_today for station: ' + id);
                    }
                }
            }


        }
    }

    async saveStationData(id, stationData) {
        await this.saveMeasure(id, 'info.stationId', stationData['_id']);
        await this.saveMeasure(id, 'info.city', stationData['place']['city']);
        await this.saveMeasure(id, 'info.country', stationData['place']['country']);
        await this.saveMeasure(id, 'info.street', stationData['place']['street']);

    }

    async saveMeasure(id, measureName, measureValue) {
        if (measureValue !== null) {
            const stateName = 'stationData.' + id + '.' + measureName;
            switch (measureName) {
                case 'rain':
                    await this.createOwnState(stateName, 'mm', 'number', 'value.rain.hour');
                    break;
                case 'rain_today':
                    await this.createOwnState(stateName, 'mm', 'number', 'value.rain.today');
                    break;
                case 'pressure':
                    await this.createOwnState(stateName, 'mBar', 'number', 'value.pressure');
                    break;
                case 'temperature':
                    await this.createOwnState(stateName, '°C', 'number', 'value.temperature');
                    break;
                case 'humidity':
                    await this.createOwnState(stateName, '%', 'number', 'value.humidity');
                    break;
                case 'windangle':
                    await this.createOwnState(stateName, null, 'string', 'weather.direction.wind ');
                    break;
                case 'windstrength':
                    await this.createOwnState(stateName, 'km/h', 'number', 'value.speed.wind');
                    break;
                case 'guststrength':
                    await this.createOwnState(stateName, 'km/h', 'number', 'value.speed.wind.gust');
                    break;
                default:
                    await this.createOwnState(stateName, null, 'string', 'text');
                    break;
            }
            await this.setStateAsync(stateName, measureValue);
        }

    }

    async createOwnState(stateName, unit, type, role) {
        await this.setObjectNotExistsAsync(stateName, {
            type: 'state',
            common: {
                name: stateName,
                type: type,
                role: role,
                read: true,
                write: true,
                unit: unit
            },
            native: {},
        });
    }

    getStationId(u) {
        const queryParams = url.parse(u, true).query;
        const stationId = queryParams['stationid'];
        return stationId;
    }

    getAuthorizationToken() {
        return new Promise((res) => {
            request({
                    url: 'https://weathermap.netatmo.com/',
                    rejectUnauthorized: false,
                },
                async function(error, response, body) {
                    if (error) {
                        logger.error('Error: ' + error);
                    }
                    //console.log('Body:' + body);
                    const regex = /window.config.accessToken = "(\w*\|\w*)";/;
                    const match = body.match(regex);
                    const token = 'Bearer ' + match[1];
                    logger.debug('Token:' + token);
                    res(token);
                }
            );
        });
    }

    getPublicData(stationId, token) {
        return new Promise((res, rej) => {
            logger.info('Getting data for stationid:' + stationId);
            request.post({
                    url: 'https://app.netatmo.net/api/getpublicmeasure',
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: token,
                    },
                    json: {
                        device_id: stationId,
                    },
                },
                async function(error, response, body) {
                    if (error) {
                        logger.error('Error:', error);
                    }
                    if (body.body) {
                        logger.debug('Body:' + body.body);

                        //console.log('Body:' + JSON.stringify(responseBody, null, 4));
                        res(body.body[0]);
                        //res(body)
                    } else {
                        logger.info('No body:' + JSON.stringify(body));
                        res();
                    }
                }
            );
        });
    }

    hasMeasure(measures, measureName) {
        let measureKey = Object.keys(measures).filter((key) => {
            return measures[key].type.indexOf(measureName) !== -1;
        });
        if (Array.isArray(measureKey) && measureKey.length > 0) {
            return true;
        } else {
            return false;
        }
    }

    getMeasureValue(measures, measureName) {
        let measureKey = Object.keys(measures).filter((key) => {
            return measures[key].type.indexOf(measureName) !== -1;
        });
        if (Array.isArray(measureKey) && measureKey.length > 0) {
            let measureIndex = measures[measureKey[0]].type.indexOf(measureName);
            const measureValues =
                measures[measureKey[0]].res[
                    Object.keys(measures[measureKey[0]].res)[0]
                ];
            const measureValue = measureValues[measureIndex];
            return measureValue;
        }
        return null;
    }

    getRainToday(measures, stationId, token) {
        return new Promise((res) => {
            //console.log('Getting data for stationid:' + stationId);
            var start = moment().startOf('day').unix();
            const moduleId = Object.keys(measures).filter((key) => {
                return measures[key].type.indexOf('rain') !== -1;
            })[0];
            const inputObj = {
                device_id: stationId,
                module_id: moduleId,
                scale: '1day',
                type: 'sum_rain',
                real_time: true,
                date_begin: start.toString(),
            };
            //console.log('InputObj:' + JSON.stringify(inputObj));
            request.post({
                    url: 'https://app.netatmo.net/api/getmeasure',
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: token,
                    },
                    json: inputObj,
                },
                async function(error, response, body) {
                    if (error) {
                        logger.error('Error:', error);
                    }
                    if (body.body) {
                        logger.debug('Body:' + JSON.stringify(body.body));

                        //console.log('Body:' + JSON.stringify(responseBody, null, 4));
                        const rainToday = body.body[0].value[0][0];
                        res(rainToday);
                        //res(body)
                    } else {
                        logger.info('No body:' + JSON.stringify(body));
                        res();
                    }
                }
            );
        });
    }

    getWindrichtungsName(value) {
        if (value === -1) return 'calm';
        if (value < 22.5 || value >= 337.5) return 'N';
        if (value < 67.5 && value >= 22.5) return 'NE';
        if (value < 125.5 && value >= 67.5) return 'E';
        if (value < 157.5 && value >= 125.5) return 'SE';
        if (value < 202.5 && value >= 157.5) return 'S';
        if (value < 247.5 && value >= 202.5) return 'SW';
        if (value < 292.5 && value >= 247.5) return 'W';
        if (value < 337.5 && value >= 292.5) return 'NW';
        return 'unknown';
    }

    sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new NetatmoCrawler(options);
} else {
    // otherwise start the instance directly
    new NetatmoCrawler();
}