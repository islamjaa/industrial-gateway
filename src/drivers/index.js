const { OmronFinsDriver } = require('./omron-fins');
const { SiemensS7Driver } = require('./siemens-s7');
const { ModbusDriver } = require('./modbus');
const { AllenBradleyDriver } = require('./allen-bradley');
const { OpcUaClientDriver } = require('./opcua-client');

function createDriver(source, tags, logger) {
  switch (source.driver) {
    case 'omron-fins': return new OmronFinsDriver(source, tags, logger);
    case 'siemens-s7': return new SiemensS7Driver(source, tags, logger);
    case 'modbus-tcp':
    case 'modbus-rtu': return new ModbusDriver(source, tags, logger);
    case 'allen-bradley': return new AllenBradleyDriver(source, tags, logger);
    case 'opcua-client': return new OpcUaClientDriver(source, tags, logger);
    default: throw new Error(`Driver not implemented: ${source.driver}`);
  }
}

module.exports = { createDriver };
