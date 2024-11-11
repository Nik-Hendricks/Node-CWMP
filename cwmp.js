import http from 'http';
import fs from 'fs';
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import BodyParser from 'body-parser-xml';

BodyParser(bodyParser);

class CWMPManager {
    constructor() {
        this.http = express();
        this.port = 7547;
        this.ev_count = 0;

        this.events = [];
        this._devices = {};
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
            },
            'get_all_param_values': (props) => {
                return _get_all_param_values(props.device_path);
            },
            'setParameterValues': (props) => {
                return _set_cwmp_parameters(generateCwmpID(), props.parameters);
            },
        }

        this.createServer();

        this.http.get('*', (req, res) => {
            console.log(`GET: ${req.url}`);
            console.log(`soap ${req.body['soap:envelope']}`);
            res.send('OK');
        }); 
        
        this.http.post('*', (req, res) => {
            if(req.body['soap:envelope'] != undefined) {
                let ev = Object.keys(req.body['soap:envelope']['soap:body'])[0];
                if(Object.keys(req.body['soap:envelope']['soap:body'])[0] == 'cwmp:inform') {
                    let device_id = req.body['soap:envelope']['soap:body'][ev].deviceid.serialnumber;
                    if(this._devices[req.connection.remoteAddress] == undefined) {
                        this._devices[req.connection.remoteAddress] = {
                            event_count: 0,
                            remote_ip: req.connection.remoteAddress,
                            device_id: device_id,
                        }
                        this.gather_all_data(device_id, req.body['soap:envelope']['soap:body'][ev]).then((data) => {
                            this._devices[req.connection.remoteAddress].data = data;
                        })
                    }
                }
                if(this._devices[req.connection.remoteAddress] !== undefined && this._devices[req.connection.remoteAddress].receive_mode == true) {
                    let d = this._devices[req.connection.remoteAddress];
                    let tasks = (this.tasks[d.device_id] == undefined) ? undefined : this.tasks[d.device_id][0];
                    if(tasks !== undefined) {
                        console.log(`Task: ${tasks.task}`);
                        tasks.callback(req.body['soap:envelope']['soap:body'][ev])
                        this.tasks[d.device_id].shift();
                        d.receive_mode = false;
                        return;
                    }
                }
                //console.log(req.body['soap:envelope']['soap:body']);
                if(this.events.filter(e => e.event == ev).length > 0) {
                    this.events.filter(e => e.event == ev)[0].action(req, res, ev);
                }else{
                    res.send('OK');
                }
            }else{
                let d = this._devices[req.connection.remoteAddress];
                let tasks = (this.tasks[d.device_id] == undefined) ? undefined : this.tasks[d.device_id][0];
                let m = (tasks !== undefined) ? this.task_map[tasks.task](tasks.props) : 'OK';
                res.send(m);
                d.receive_mode = true;
            }
        });

        this.add_event('cwmp:inform', (req, res, ev) => {
            let device_id = req.body['soap:envelope']['soap:body'][ev].deviceid.serialnumber;
            this._devices[req.connection.remoteAddress].event_count++;
            res.send(_ack_xml(generateCwmpID(), 'InformResponse'));
        });
        
        this.add_event('soap:fault', (req, res, ev) => {
            console.log('Fault');
            console.log(req.body);  
            console.log(JSON.stringify(req.body));
        })
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

    trim_parsed_xml_obj(obj, keep) {
        var ret = [];
        for(var key in obj) {
            if(obj[key] !== undefined) {
                ret[`${obj[key].name}`] = {[keep]: obj[key][keep]};
            }
        }
        return ret;
    }
    
    create_parameter_value_tree(info) {
        let obj = {};
        let data = this.trim_parsed_xml_obj(info, 'value')
        const tree = {};
        for (const key in data) {
          const segments = key.split('.');
          let current = tree;
          for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if(segment == '') {
                current._value = data[key].value;
            }else if (i === segments.length - 1) {
              current[segment] = { _value: data[key].value };
            } else {
              if (!current[segment]) {
                current[segment] = {};
              }
              current = current[segment];
            }
          }
        }
   
        return tree;
    }

    create_parameter_info_tree(info, values) {
        console.log(info)
        let obj = {};
        let data = this.trim_parsed_xml_obj(info, 'writable')
        let value_tree = this.create_parameter_value_tree(values);
        let v = [];

        values.forEach((x) => {
            v[x.name] = x.value['$']['xsi:type']
        })
        const tree = {};
        for (const key in data) {
          const segments = key.split('.');
          let current = tree;
          for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if(segment == '') {
                current._writable = (data[key].writable == "true") ? true : false;
                current._value = this.get_obj_value(value_tree, segments.join('.'));
                current._type = v[segments.join('.')];
            }else if (i === segments.length - 1) {
                current[segment] = { 
                    _writable: (data[key].writable == "true") ? true : false,
                    _value: this.get_obj_value(value_tree, segments.join('.')),
                    _type: v[segments.join('.')]
                };
            } else {
              if (!current[segment]) {
                current[segment] = {};
              }
              current = current[segment];
            }
          }
        }

        let is_obj = (node) => {
            let ret = false;
            for (const key in node) {
                if(typeof node[key] === 'object') {
                    ret = true;
                }
            }
            return ret;
        }

        const determineObject = (node) => {
            for (const key in node) {
                if (typeof node[key] === 'object') {
                    node[key]._object = determineObject(node[key]);
                }
            }
            return is_obj(node);
        };

        determineObject(tree);

    
        return tree;
    }

    get_obj_value(obj, path) {
        //get the value from the values tree "obj" using the path from the info tree "path" which is in format "Device.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress"
        let path_array = path.split('.');
        let node = obj;
        path_array.forEach((p) => {
            if(node[p] !== undefined) {
                node = node[p];
            }
        });
        return node['_value'] !== undefined ? node['_value']['_'] : undefined;
    }

    get_obj_data_type(obj, path) {
        let path_array = path.split('.');
        let node = obj;
        path_array.forEach((p) => {
            if(node[p] !== undefined) {
                node = node[p];
            }
        });

        console.log(node);

        return node['_type'] !== undefined ? node['_type'] : undefined;
    }

    add_task(device_id, task, props, callback) {
        if(this.tasks[device_id] == undefined) {
            this.tasks[device_id] = [];
        }
        this.tasks[device_id].push({ task, props, callback });
    }

    gather_all_data(device_id, inform_data) {
        return new Promise(resolve => {
            this.add_task(device_id, 'get_all_params', {device_path: 'Device.' }, (ps) => {
                this.add_task(device_id, 'get_all_param_values', {device_path: 'Device.'}, (vs) => {
                    //console.log(ps);    
                    //console.log(vs.parameterlist.parametervaluestruct);
                    if(ps != undefined) {
                        //resolve(this.create_parameter_info_tree(ps.parameterlist.parameterinfostruct, inform_data['parameterlist']['parametervaluestruct']));
                        resolve(this.create_parameter_info_tree(ps.parameterlist.parameterinfostruct, vs.parameterlist.parametervaluestruct));
                    }
                })
            }); 
        }) 
    }

    set_device_parameters(device_id, parameters) {
        return new Promise (resolve => {
            this.add_task(device_id, 'setParameterValues', {parameters}, (ps) => {
                resolve(ps);
            });
        })
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
    parameters = Object.keys(parameters).map((key) => {
        return {name: key, value: parameters[key]};
    });
    console.log(parameters);
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
        <soap:Header>
            <cwmp:ID soap:mustUnderstand="1">${transaction_id}</cwmp:ID>
        </soap:Header>
        <soap:Body>
            <cwmp:SetParameterValues>
                <ParameterList soap-enc:arrayType="cwmp:ParameterValueStruct[${parameters.length}]">
                    ${parameters.map((p) => {
                        return `<ParameterValueStruct>
                            <Name>${p.name}</Name>
                            <Value xsi:type="xsd:string">${p.value}</Value>
                        </ParameterValueStruct>`;
                    })}
                </ParameterList>
            </cwmp:SetParameterValues>
        </soap:Body>
    </soap:Envelope>
    </xml>`;

    return xml;
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

let _get_all_param_values = (device_path) => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
        <soapenv:Body>
            <cwmp:GetParameterValues>
                <ParameterNames soap-enc:arrayType="xsd:string[1]">
                    <string>${device_path}</string>
                </ParameterNames>
            </cwmp:GetParameterValues>
        </soapenv:Body>
    </soapenv:Envelope>
    </xml>`;

    return xml;
}




let generateCwmpID = () => {
    return crypto.randomBytes(4).toString('hex'); // Generates a random ID
};

export default CWMPManager;






