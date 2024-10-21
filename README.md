# Node-CWMP

Node-CWMP is a lightweight Node.js library for building and managing a CPE WAN Management Protocol (CWMP) server. It allows you to interact with devices, handle CWMP messages, and manage parameters through SOAP requests. This library is useful for TR-069 management server implementation.

## Features
- Device management and task scheduling
- SOAP-based communication with devices
- TR-069 protocol support
- Lightweight and fast

## Installation

1. Clone the repository:
    ```bash
    git clone https://github.com/Nik-Hendricks/Node-CWMP.git
    ```
2. Navigate to the directory:
    ```bash
    cd Node-CWMP
    ```
3. Install dependencies:
    ```bash
    npm install
    ```
4. Include the library in your project:
    ```javascript
    const cwmp = require('./cwmp');
    ```
5. Invoke the CWMPManager class:
    ```javascript
    const cwmp = new CWMPManager();
    ```
    

## Usage

### Starting the CWMP Server
The CWMP server starts automatically when you run the library. It listens on port `7547` by default and is ready to accept requests from devices.

### Example Usage
To add a task for a device:
```javascript
cwmp.add_task('DEVICE_ID', 'get_param', { param_name: 'Device.DeviceInfo.SerialNumber' }, (param) => {
    console.log('Received Parameter:', param);
});
