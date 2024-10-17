const http          = require('http');
const fs            = require('fs');
const express       = require('express'); 
const nedb          = require('nedb');
const bodyParser    = require('body-parser');
const crypto        = require('crypto');
require('body-parser-xml')(bodyParser);

class CWMPManager {
    constructor() {
        this.http = express();
        this.port = 7547;
        this.ev_count = 0;
        this.DB = {
            devices: new nedb({ filename: 'DB/devices.db', autoload: true }),
            logs: new nedb({ filename: 'DB/logs.db', autoload: true })
        }

        this.events = [];
        this.devices = [];
        this.tasks = [];

        this.task_map = {
            'get_param': (props) => {
                return _get_param_xml(generateCwmpID(), props.param_name);
            },

            'set_param': (props) => {
                return _set_cwmp_parameters(generateCwmpID(), props.parameters);
            },
            'reboot': (props) => {
                return _reboot_xml(generateCwmpID());
            },
            'get_all_params': (props) => {
                return _get_all_params(props.device_path);
            }
        }

        this.createServer();

        this.http.get('*', (req, res) => {
            console.log(req)
        }); 
        
        this.http.post('*', (req, res) => {
            this.ev_count++;
            let task = this.tasks[0];
            let m = (task !== undefined) ? this.task_map[task.task](task.props) : 'OK';
            if(typeof req.body == 'string') {
                res.send(m);
            }else if(req.body['soap:envelope'] != undefined) {
                let ev = Object.keys(req.body['soap:envelope']['soap:body'])[0];
                if(task !== undefined && this.ev_count > 1) {
                    task.callback(req.body['soap:envelope']['soap:body'][ev]);
                    this.tasks.shift();
                }
                if(this.events.filter(e => e.event == ev).length > 0) {
                    this.events.filter(e => e.event == ev)[0].action(req, res, ev);
                }else{
                    res.send('OK');
                }
            }else{
                res.send('OK');
            }
        });

        this.add_event('cwmp:inform', (req, res, ev) => {
            console.log('Inform');
            let transaction_id = req.body['soap:envelope']['soap:header']['cwmp:id']['_'];
            let device_id = req.body['soap:envelope']['soap:body'][ev].deviceid.serialnumber;
            var obj = this.sort_cwmp_parameters(req.body['soap:envelope']['soap:body'][ev].parameterlist.parametervaluestruct);
            obj.deviceid = req.body['soap:envelope']['soap:body'][ev].deviceid.serialnumber;
            console.log(device_id)
            this.add_device(obj);
            let xml = _ack_xml(transaction_id, 'cwmp:InformResponse');
            //console.log(obj)
            res.send(xml);
        });
        
        this.add_event('soap:fault', (req, res, ev) => {
            console.log('Fault');
            console.log(req.body);  
            console.log(JSON.stringify(req.body));
        })
        
        //this.add_event('cwmp:getparametervaluesresponse', (req, res, ev) => {
        //    console.log('GetParameterValuesResponse');
        //    //console.log(req.body);
        //    //console.log(JSON.stringify(req.body));
        //    res.send('OK');
        //})

    }

    createServer() {
        this.http.use(bodyParser.xml({
            limit: '1MB',
            xmlParseOptions: {
                normalize: true,
                normalizeTags: true,
                explicitArray: false
            }
        }));

        this.http.listen(this.port, () => {
            console.log(`CWMP Server running at http://localhost:${this.port}`);
        })
    }

    add_event(event, action) {
        this.events.push({ event, action });
    }

    add_device(device) {
        let id = device.deviceid;
        this.DB.devices.update({ _id: id }, { $set: device }, { upsert: true }, (err, numReplaced, upsert) => {
            if (err) {
                console.log(err);
            }
        });
        this.devices[id] = device;
    }

    sort_cwmp_parameters(parameters) {
        let obj = {};
        parameters.forEach((param) => {
            let path = param.name.split('.');
            let key = path.pop();
            let node = obj;
            path.forEach((p) => {
                if (!node.hasOwnProperty(p)) {
                    node[p] = {
                        '_value': null,
                        '_object': false
                    };
                }
                node = node[p];
                //console.log(node);
            });
            node['_object'] = true;
            node[key] = {
                '_value': param.value['_'],
                '_object': param.value['$']['xsi:type'] == 'xsd:object' ? true : false
            };
        });
        return obj;
    }

    summon_device(device) {
        console.log(device);
    }

    add_task(task, props, callback) {
        this.tasks.push({ task, props, callback });
    }
}

let _reboot_xml = (transaction_id) => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
        <soap:Header>
            <cwmp:ID soap:mustUnderstand="1">${transaction_id}</cwmp:ID>
        </soap:Header>
        <soap:Body>
            <cwmp:Reboot/>
        </soap:Body>
    </soap:Envelope>
    </xml>`;
    return xml;
}

let _ack_xml = (transaction_id, event) => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
        <soap:Header>
            <cwmp:ID soap:mustUnderstand="1">${transaction_id}</cwmp:ID>
        </soap:Header>
        <soap:Body>
            <${event}>
                <MaxEnvelopes>1</MaxEnvelopes>
            </${event}>
        </soap:Body>
    </soap:Envelope>
    </xml>`;

    return xml;
}

let _get_param_xml = (transaction_id, param) => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
        <soap:Header>
            <cwmp:ID soap:mustUnderstand="1">${transaction_id}</cwmp:ID>
        </soap:Header>
        <soap:Body>
            <cwmp:GetParameterValues>
                <ParameterNames soap-enc:arrayType="xsd:string[1]">
                    <string>${param}</string>
                </ParameterNames>
            </cwmp:GetParameterValues>
        </soap:Body>
    </soap:Envelope>
    </xml>`;

    return xml;
}

let _set_cwmp_parameters = (transaction_id, parameters) => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
        <soap:Header>
            <cwmp:ID soap:mustUnderstand="1">${transaction_id}</cwmp:ID>
        </soap:Header>
        <soap:Body>
            <cwmp:SetParameterValues>
                <ParameterList soap-enc:arrayType="cwmp:ParameterValueStruct[${parameters.length}]">
                    ${parameters.map((param) => {
                        return `<ParameterValueStruct>
                        <Name>${param.name}</Name>
                        <Value xsi:type="xsd:string">${param.value}</Value>
                    </ParameterValueStruct>`
                    })}
                </ParameterList>
            </cwmp:SetParameterValues>
        </soap:Body>
    </soap:Envelope>
    </xml>`;
};

let _get_all_params = (device_path) => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
        <soapenv:Body>
            <cwmp:GetParameterNames>
                <ParameterPath>${device_path}</ParameterPath>
                <NextLevel>0</NextLevel>
            </cwmp:GetParameterNames>
        </soapenv:Body>
    </soapenv:Envelope>
    </xml>`;

    return xml;
}




let generateCwmpID = () => {
    return crypto.randomBytes(4).toString('hex'); // Generates a random ID
};

const cwmp = new CWMPManager();
cwmp.add_task('get_param', { deviceid: '1234', param_name: 'Device.DeviceInfo.SerialNumber' }, (param) => {
    console.log('params')
    //console.log(param.parameterlist.parametervaluestruct);
});

cwmp.add_task('reboot', { deviceid: '1234' }, (data) => {
    console.log('reboot')
    console.log(data)
})

//cwmp.add_task('set_param', { deviceid: '1234', parameters: [{ name: 'Device.DeviceInfo.SerialNumber', value: '1234' }] }, (param) => {
//    console.log('params are')
//    console.log(param.parameterlist.parametervaluestruct);
//});

cwmp.add_task('get_all_params', { deviceid: '1234', device_path:'Device.' }, (param) => {
    console.log('params are')
    console.log(param.parameterlist.parameterinfostruct);
})