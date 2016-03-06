'use strict';

(function(){

var socketio = require('socket.io'),
  express = require('express'),
  http = require('http'),
  net = require('net'),
  Class = require('mixin-pro').createClass;

var WebTelnetProxy = Class({
  constructor: function WebTelnetProxy( conf ) {
    this.conf = conf;
    this.DROP_KICK_TIME = 30; // 30 sec
    this.reset();
  },

  reset: function() {
    this.io = null;
    this.timer = 0;
    this.isRunning = false;
    this.services = {};
    this.sockets = {};  // sid -> socket
    this.socketsCount = 0;
  },

  // context->func(req, reply(err, ret));
  // func.call(context, req, reply(err, ret));
  addService: function(key, func, context) {
    if(typeof func === 'function') {
      this.services[key] = {
        func: func,
        context: context,
      }
    }
  },

  removeService: function(key) {
    if(key in this.services) {
      delete this.services[key];
    }
  },

  startup: function() {
    if(this.isRunning) throw new Error('server is already running.');

    var proxy = this;
    var conf = this.conf;
    var now = Date.now();

    // init network listener
    var app = express().use(express.static(conf.www));
    var httpserver = http.createServer(app);
    var io = this.io = socketio.listen(httpserver);
    io.on('connection', function(sock){
      proxy.onConnected(sock);
    });
    httpserver.listen(conf.web.port, conf.web.host, function(){
      console.log('listening on ' + conf.web.host + ':' + conf.web.port);
    });

    this.isRunning = true;

    // init tick() timer
    proxy.tick();
    proxy.timer = setInterval(function(){
      proxy.tick();
    }, 1000);
    
    return this;
  },

  shutdown: function() {
    if(!this.isRunning) return;

    // clear tick() timer
    if(this.timer) clearInterval(this.timer);

    // close socket connection
    if(this.io) this.io.close();

    // close all connections
    var sockets = this.sockets;
    for(var j in sockets) {
      sockets[j].disconnect();
      delete sockets[j];
    }

    this.reset();

    return this;
  },

  tick: function() {
    var self = this;
    var now = Date.now();
  },

  onDisconnected: function(webSock) {
    var proxy = this;
    var peerSock = webSock.peerSock;
    if(peerSock) {
      webSock.peerSock = null;
      peerSock.peerSock = null;
      peerSock.end();
    }
    delete proxy.sockets[ webSock.id ];
    proxy.socketsCount --;
  },

  connectTelnet: function(webSock) {
    var proxy = this;

    var telnet = net.connect( proxy.conf.telnet.port, proxy.conf.telnet.host, function() {
      console.log('telnet connected');
      webSock.emit('status', 'Server connected.\n');
    });

    telnet.peerSock = webSock;
    webSock.peerSock = telnet;

    telnet.on('data', function(buf) {
      //console.log('telnet: ', buf.toString());
      var peerSock = telnet.peerSock;
      if(peerSock) {
        var arrBuf = new ArrayBuffer(buf.length);
        var view = new Uint8Array(arrBuf);
        for(var i=0; i<buf.length; ++i) {
          view[i] = buf[i];
        }
        peerSock.emit('stream', arrBuf);
      }
    });
    telnet.on('error', function(){
    });
    telnet.on('close', function(){
      console.log('telnet disconnected');
      webSock.emit('status', 'Server disconnected.\n');
    });
    telnet.on('end', function(){
      var peerSock = telnet.peerSock;
      if(peerSock) {
        peerSock.peerSock = null;
        telnet.peerSock = null;
      }
    });
  },

  onConnected: function(webSock) {
    var proxy = this;

    if(proxy.conf.logTraffic) {
      console.log('web client connected, socket id: ' + webSock.id);
      webSock.logTraffic = 1;
    }

    webSock.on('stream', function(message) {
      //console.log('websocket: ', message);
      var peerSock = webSock.peerSock;
      if(peerSock) {
        peerSock.write(message);
      } else {
        proxy.connectTelnet(webSock);
      }
    });

    webSock.on('disconnect', function(){
      console.log('web client disconnected, socket id: ' + webSock.id);
      proxy.onDisconnected(webSock);
    });

    // implement the rpc interface, so we can reuse webclient.js
    /* {
      uid, // optional
      pin, // optional
      seq: seq,
      f: method,
      args: args,
    } */
    webSock.on('rpc', function(req){
      console.log('rpc', req.f);
      var service = proxy.services[req.f];
      var func = service.func;
      var context = service.context;
      if(typeof func === 'function') {
        var reply = function(err, ret) {
          webSock.emit('reply', {
            seq: req.seq,
            err: err,
            ret: ret,
          });
        };
        func.call(context, req.args, reply);
      }
    });

    proxy.sockets[webSock.id] = webSock;
    proxy.socketsCount ++;
  },
});

WebTelnetProxy.startProxy = function(conf) {
  return new WebTelnetProxy(conf).startup();
}

exports = module.exports = WebTelnetProxy;

})();
