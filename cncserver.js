/**
 * @file CNC Server for communicating with hardware via serial commands!
 * Supports EiBotBoart for Eggbot, Ostrich Eggbot and Sylvia's Super-Awesome
 * WaterColorBot
 *
 * This script can be run standalone via 'node cncserver.js' with command line
 * options as described in the readme, or as a module: example shown:
 *
 * var cncserver = require('cncserver');
 *
 * cncserver.conf.global.overrides({
 *   httpPort: 1234,
 *   swapMotors: true
 * });
 *
 * cncserver.start({
 *   error: function callback(err){ // ERROR! },
 *   success: function callback(){ // SUCCESS! },
 *   disconnect: function callback(){ //BOT DISCONNECTED! }
 * };
 *
 */

// REQUIRES ====================================================================
var nconf = require('nconf');         // Configuration and INI file
var express = require('express');     // Webserver
var fs = require('fs');               // File System management
var path = require('path');           // Path management and normalization
var extend = require('util')._extend; // Util for cloning objects

// CONFIGURATION ===============================================================
var gConf = new nconf.Provider();
var botConf = new nconf.Provider();

// Pull conf from env, or arguments
gConf.env().argv();

// STATE Variables

// The pen: this holds the state of the pen at the "latest tip" of the buffer,
// meaning that as soon as an instruction is received, this variable is updated
// to reflect the intention of the buffered item.
var pen = {
  x: 0, // Assume we start in top left corner
  y: 0,
  state: 0, // Pen state is from 0 (up/off) to 1 (down/on)
  height: 0, // Last set pen height in output servo value
  busy: false,
  tool: 'color0',
  lastDuration: 0, // Holds the last movement timing in milliseconds
  distanceCounter: 0, // Holds a running tally of distance travelled
  simulation: 0 // Fake everything and act like it's working, no serial
}

// actualPen: This is set to the state of the pen variable as it passes through
// the buffer queue and into the robot, meant to reflect the actual position and
// state of the robot, and will be where the pen object is reset to when the
// buffer is cleared and the future state is lost.
var actualPen = extend({}, pen);

// Global Defaults (also used to write the initial config.ini)
var globalConfigDefaults = {
  httpPort: 4242,
  httpLocalOnly: true,
  swapMotors: false,
  invertAxis: {
    x: false,
    y: false
  },
  serialPath: "{auto}", // Empty for auto-config
  bufferLatencyOffset: 50, // Number of ms to move each command closer together
  corsDomain: '*', // Start as open to CORs enabled browser clients
  debug: false,
  botType: 'watercolorbot',
  botOverride: {
    info: "Override bot specific settings like > [botOverride.eggbot] servo:max = 1234"
  }
};

// Hold common bot specific contants (also helps with string conversions)
var BOT = {}; // Set after botConfig is loaded

// INTIAL SETUP ================================================================
var app = express();
var server = require('http').createServer(app);

// Global express initialization (must run before any endpoint creation)
app.configure(function(){
  app.use("/", express.static(__dirname + '/example'));
  app.use(express.bodyParser());
});

var serialport = require("serialport");
var serialPort = false;
var SerialPort = serialport.SerialPort;

// Buffer State variables
var buffer = [];
var bufferRunning = false;
var bufferPaused = false;
var bufferNewlyPaused = false; // Trigger for pause callback on executeNext()
var bufferPauseCallback = null;
var bufferPausePen = null; // Hold the state when paused to return to for resuming

// Load the Global Configuration (from config, defaults & CL vars)
loadGlobalConfig(standaloneOrModuleInit);

// Only if we're running standalone... try to start the server immediately!
function standaloneOrModuleInit() {
  if (!module.parent) {
    // Load the bot specific configuration, defaulting to gConf bot type
    loadBotConfig(function(){
      // Attempt Initial Serial Connection
      connectSerial({
        error: function() {
          console.error('CONNECTSERIAL ERROR!');
          simulationModeInit();
          serialPortReadyCallback();
        },
        connect: function(){
          //console.log('CONNECTSERIAL CONNECT!');
          serialPortReadyCallback();
        },
        disconnect: serialPortCloseCallback
      });
    });

  } else { // Export the module's useful API functions! ========================
    // Connect to serial and start server
    exports.start = function(options) {
      loadBotConfig(function(){
        connectSerial({
          success: function() { // Successfully connected
            if (options.success) options.success();
          },
          error: function(info) { // Error during connection attempt
            if (options.error) options.error(info);
          },
          connect: function() { // Callback for first serial connect, or re-connect
            serialPortReadyCallback();
            if (options.connect) options.connect();
          },
          disconnect: function() { // Callback for serial disconnect
            serialPortCloseCallback();
            if (options.disconnect) options.disconnect();
          }
        });
      }, options.botType);
    }

    // Retreieve list of bot configs
    exports.getSupportedBots = function() {
      var ini = require('ini');
      var list = fs.readdirSync(path.resolve(__dirname, 'machine_types'));
      var out = {};
      for(var i in list) {
        var data = ini.parse(fs.readFileSync(path.resolve(__dirname, 'machine_types', list[i]), 'utf-8'));
        var type = list[i].split('.')[0];
        out[type] = {
          name: data.name,
          data: data
        };
      }
      return out;
    }

    // Direct configuration access (use the getters and override setters!)
    exports.conf = {
      bot: botConf,
      global: gConf
    }

    // Export to reset global config
    exports.loadGlobalConfig = loadGlobalConfig;

    // Export to reset or load different bot config
    exports.loadBotConfig = loadBotConfig;

    // Continue with simulation mode
    exports.continueSimulation = simulationModeInit;

    // Export Serial Ready Init (starts webserver)
    exports.serialReadyInit = serialPortReadyCallback;

    // Get available serial ports
    exports.getPorts = function(cb) {
      require("serialport").list(function (err, ports) {
        cb(ports);
      });
    }

    // Set pen direct command
    exports.setPen = function(value) {
      pen.state = value;
      serialCommand('SP,' + (pen.state == 1 ? 1 : 0));
    }
    exports.directSetPen=function(){};

    // Export ReST Server endpoint creation utility
    exports.createServerEndpoint = createServerEndpoint;
  }
}

// Grouping function to send off the initial configuration for the bot
function sendBotConfig() {
  // EBB Specific Config =================================
  if (botConf.get('controller').name == 'EiBotBoard') {
    console.log('Sending EBB config...')
    run('custom', 'EM,' + botConf.get('speed:precision'));

    // Send twice for good measure
    run('custom', 'SC,10,' + botConf.get('servo:rate'));
    run('custom', 'SC,10,' + botConf.get('servo:rate'));
  }

  console.info('---=== ' + botConf.get('name') + ' is ready to receive commands ===---');
}

// Start express HTTP server for API on the given port
var serverStarted = false;
function startServer() {
  // Only run start server once...
  if (serverStarted) return;
  serverStarted = true;

  var hostname = gConf.get('httpLocalOnly') ? 'localhost' : null;

  // Catch Addr in Use Error
  server.on('error', function (e) {
    if (e.code == 'EADDRINUSE') {
      console.log('Address in use, retrying...');
      setTimeout(function () {
        closeServer();
        server.listen(gConf.get('httpPort'), hostname);
      }, 1000);
    }
  });

  server.listen(gConf.get('httpPort'), hostname, function(){
    // Properly close down server on fail/close
    process.on('uncaughtException', function(err){ console.log(err); closeServer(); });
    process.on('SIGTERM', function(err){ console.log(err); closeServer(); });
  });
}

function closeServer() {
  try {
    server.close();
  } catch(e) {
    console.log("Whoops, server wasn't running.. Oh well.")
  }
}

// No events are bound till we have attempted a serial connection
function serialPortReadyCallback() {

  console.log('CNC server API listening on ' +
    (gConf.get('httpLocalOnly') ? 'localhost' : '*') +
    ':' + gConf.get('httpPort')
  );

  // Is the serialport ready? Start reading
  if (!pen.simulation) {
    serialPort.on("data", serialReadline);
  }


  sendBotConfig();
  startServer();

  // CNC Server API ============================================================
  // Return/Set CNCServer Configuration ========================================
  createServerEndpoint("/v1/settings", function(req, res){
    if (req.route.method == 'get') { // Get list of tools
      return {code: 200, body: {
        global: '/v1/settings/global',
        bot: '/v1/settings/bot'
      }};
    } else {
      return false;
    }
  });

  createServerEndpoint("/v1/settings/:type", function(req, res){
    // Sanity check type
    var setType = req.params.type;
    if (setType !== 'global' && setType !== 'bot'){
      return [404, 'Settings group not found'];
    }

    var conf = setType == 'global' ? gConf : botConf;

    function getSettings() {
      var out = {};
      // Clean the output for global as it contains all commandline env vars!
      if (setType == 'global') {
        var g = conf.get();
        for (var i in g) {
          if (i == "botOverride") {
            break;
          }
          out[i] = g[i];
        }
      } else {
        out = conf.get();
      }
      return out;
    }

    // Get the full list for the type
    if (req.route.method == 'get') {
      return {code: 200, body: getSettings()};
    } else if (req.route.method == 'put') {
      for (var i in req.body) {
        conf.set(i, req.body[i]);
      }
      return {code: 200, body: getSettings()};
    } else {
      return false;
    }
  });

  // Return/Set PEN state  API =================================================
  createServerEndpoint("/v1/pen", function(req, res){
    if (req.route.method == 'put') {
      // SET/UPDATE pen status
      setPen(req.body, function(stat){
        if (!stat) {
          res.status(500).send(JSON.stringify({
            status: "Error setting pen!"
          }));
        } else {
          if (req.body.ignoreTimeout){
            res.status(202).send(JSON.stringify(pen));
          }
          res.status(200).send(JSON.stringify(pen));
        }
      });

      return true; // Tell endpoint wrapper we'll handle the response
    } else if (req.route.method == 'delete'){
      // Reset pen to defaults (park)
      setHeight('up');
      setPen({x: 0, y:0, park: true, skipBuffer: req.body.skipBuffer}, function(stat){
        if (!stat) {
          res.status(500).send(JSON.stringify({
            status: "Error parking pen!"
          }));
        }
        res.status(200).send(JSON.stringify(pen));
      });

      return true; // Tell endpoint wrapper we'll handle the response
    } else if (req.route.method == 'get'){
      return {code: 200, body: pen};
    } else  {
      return false;
    }
  });

  // Return/Set Motor state API ================================================
  createServerEndpoint("/v1/motors", function(req, res){
    // Disable/unlock motors
    if (req.route.method == 'delete') {
      run('custom', 'EM,0,0');
      return [201, 'Disable Queued'];
    } else if (req.route.method == 'put') {
      if (req.body.reset == 1) {
        // TODO: This could totally break queueing as movements are queued with
        // offsets that break if the relative position doesn't match!
        pen.x = 0;
        pen.y = 0;
        console.log('Motor offset reset to zero')
        return [200, 'Motor offset zeroed'];
      } else {
        return [406, 'Input not acceptable, see API spec for details.'];
      }
    } else {
      return false;
    }
  });

  // Command buffer API ========================================================
  createServerEndpoint("/v1/buffer", function(req, res){
    if (req.route.method == 'get' || req.route.method == 'put') {

      // Pause/resume
      if (typeof req.body.paused == "boolean") {
        if (req.body.paused != bufferPaused) {
          bufferPaused = req.body.paused;
          console.log('Run buffer ' + (bufferPaused ? 'paused!': 'resumed!'));
          bufferRunning = false; // Force a followup check as the paused var has changed

          bufferNewlyPaused = bufferPaused; // Changed to paused!

          // Hold on to both pen states to return to!
          if (bufferPaused) {
            bufferPausePen = [extend({}, actualPen), extend({}, pen)];
          }
        }
      }

      // Resuming? Move back to starting position
      // TODO: This is far too complicated and broken for more than one skipBuffer
      // request, and should probably be changed
      if (!bufferPaused && bufferPausePen) {
        bufferPaused = true; // Pause for a bit until we move back to last pos
        console.log('Moving back to pre-pause position...')
        movePenAbs(bufferPausePen[0], function(){
          // Put the pen back to where it was
          pen = extend({}, bufferPausePen[1]);

          bufferPaused = false;
          bufferPausePen = null;
          res.status(200).send(JSON.stringify({
            running: bufferRunning,
            paused: bufferPaused,
            count: buffer.length,
            buffer: buffer
          }));
        }, false, true);
        return true; // Don't finish the response till after move back ^^^
      }

      if (!bufferNewlyPaused || buffer.length === 0) {
        bufferNewlyPaused = false; // In case paused with 0 items in buffer

        return {code: 200, body: {
          running: bufferRunning,
          paused: bufferPaused,
          count: buffer.length,
          buffer: buffer
        }};
      } else { // Buffer isn't empty and we're newly paused
        // Wait until last item has finished before returning
        console.log('Waiting for last item to finish...');

        bufferPauseCallback = function(){
          res.status(200).send(JSON.stringify({
            running: bufferRunning,
            paused: bufferPaused,
            count: buffer.length,
            buffer: buffer
          }));

          bufferNewlyPaused = false;
        };

        return true; // Don't finish the response till later
      }

    } else if (req.route.method == 'delete') {
      buffer = [];

      // Reset the state of the buffer tip pen to the state of the actual robot.
      // If this isn't done, it will be assumed to be a state that was deleted
      // and never sent out in the line above.
      pen = extend({}, actualPen);

      console.log('Run buffer cleared!')
      return [200, 'Buffer Cleared'];
    } else {
      return false;
    }
  });

  // Get/Change Tool API =======================================================
  createServerEndpoint("/v1/tools", function(req, res){
    if (req.route.method == 'get') { // Get list of tools
      return {code: 200, body:{tools: Object.keys(botConf.get('tools'))}};
    } else {
      return false;
    }
  });

  createServerEndpoint("/v1/tools/:tool", function(req, res){
    var toolName = req.params.tool;
    // TODO: Support other tool methods... (needs API design!)
    if (req.route.method == 'put') { // Set Tool
      if (botConf.get('tools:' + toolName)){
        setTool(toolName, function(data){
          pen.tool = toolName;
          res.status(200).send(JSON.stringify({
            status: 'Tool changed to ' + toolName
          }));
        });
        return true; // Tell endpoint wrapper we'll handle the response
      } else {
        return [404, "Tool: '" + toolName + "' not found"];
      }
    } else {
      return false;
    }
  });


  // UTILITY FUNCTIONS =======================================================

  // Send direct setup var command
  exports.sendSetup = sendSetup;
  function sendSetup(id, value) {
    // TODO: Make this WCB specific, or refactor to be general
    run('custom', 'SC,' + id + ',' + value);
  }

  function setPen(inPen, callback) {
    // Force the distanceCounter to be a number (was coming up as null)
    pen.distanceCounter = parseInt(pen.distanceCounter);

    // Counter Reset
    if (inPen.resetCounter) {
      pen.distanceCounter = Number(0);
      callback(true);
      return;
    }

    // Setting the value of simulation
    if (typeof inPen.simulation != "undefined") {

      // No change
      if (inPen.simulation == pen.simulation) {
        callback(true);
        return;
      }

      if (inPen.simulation == 0) { // Attempt to connect to serial
        connectSerial({complete: callback});
      } else {  // Turn off serial!
        // TODO: Actually nullify connection.. no use case worth it yet
        simulationModeInit();
      }

      return;
    }


    // State has changed
    if (typeof inPen.state != "undefined") {
      if (inPen.state != pen.state) {
        setHeight(inPen.state, callback, inPen.skipBuffer);
        return;
      }
    }

    // Absolute positions are set
    if (inPen.x !== undefined){
      // Input values are given as percentages of working area (not max area)

      // Don't accept bad input
      if (isNaN(inPen.x) || isNaN(inPen.y) || !isFinite(inPen.x) || !isFinite(inPen.y)) {
        callback(false);
        return;
      }

      // Sanity check incoming values
      inPen.x  = inPen.x > 100 ? 100 : inPen.x;
      inPen.x  = inPen.x < 0 ? 0 : inPen.x;

      inPen.y  = inPen.y > 100 ? 100 : inPen.y;
      inPen.y  = inPen.y < 0 ? 0 : inPen.y;

      // Convert the percentage values into real absolute and appropriate values
      var absInput = {
        x: BOT.workArea.left + ((inPen.x / 100) * (BOT.maxArea.width - BOT.workArea.left)),
        y: BOT.workArea.top + ((inPen.y / 100) * (BOT.maxArea.height - BOT.workArea.top))
      }

      if (inPen.park) {
        absInput.x-= BOT.workArea.left;
        absInput.y-= BOT.workArea.top;

        // Don't repark if already parked
        if (pen.x == 0 && pen.y == 0) {
          callback(false);
          return;
        }
      }

      // Actually move the pen!
      var distance = movePenAbs(absInput, callback, inPen.ignoreTimeout, inPen.skipBuffer);
      if (pen.state === 'draw' || pen.state === 1) {
        pen.distanceCounter = parseInt(Number(distance) + Number(pen.distanceCounter));
      }
      return;
    }

    if (callback) callback(true);
  }

  // Set servo position
  exports.setHeight = setHeight;
  function setHeight(height, callback, skipBuffer) {
    var fullRange = false; // Whether to use the full min/max range
    var min = parseInt(botConf.get('servo:min'));
    var max = parseInt(botConf.get('servo:max'));
    var range = max - min;
    var stateValue = null; // Placeholder for what to set pen state to
    var p = botConf.get('servo:presets');
    var servoDuration = botConf.get('servo:duration');

    // Validate Height, and conform to a bottom to top based percentage 0 to 100
    if (isNaN(parseInt(height))){ // Textual position!
      if (p[height]) {
        stateValue = height;
        height = parseFloat(p[height]);
      } else { // Textual expression not found, default to UP
        height = p.up;
        stateValue = 'up';
      }
      fullRange = true;
    } else { // Numerical position (0 to 1), moves between up (0) and draw (1)
      height = Math.abs(parseFloat(height));
      height = height > 1 ?  1 : height; // Limit to 1
      stateValue = height;

      // Reverse value and lock to 0 to 100 percentage with 1 decimal place
      height = parseInt((1 - height) * 1000) / 10;
    }

    // Lower the range when using 0 to 1 values
    if (!fullRange) {
      min = ((p.draw / 100) * range) + min;
      max = ((p.up / 100) * range) + parseInt(botConf.get('servo:min'));

      range = max - min;
    }

    // Sanity check incoming height value to 0 to 100
    height = height > 100 ? 100 : height;
    height = height < 0 ? 0 : height;

    // Calculate the servo value from percentage
    height = Math.round(((height / 100) * range) + min);


    // Pro-rate the duration depending on amount of change
    if (pen.height) {
      range = parseInt(botConf.get('servo:max')) - parseInt(botConf.get('servo:min'));
      servoDuration = Math.round((Math.abs(height - pen.height) / range) * servoDuration)+1;
    }

    pen.height = height;
    pen.state = stateValue;

    // Run the height into the command buffer
    run('height', height, servoDuration, skipBuffer);

    // Pen lift / drop
    if (callback) {
      // Force the EBB block buffer for the pen change state
      setTimeout(function(){
        callback(1);
      }, Math.max(servoDuration - gConf.get('bufferLatencyOffset'), 0));
    }
  }

  // Tool change
  exports.setTool = setTool;
  function setTool(toolName, callback) {
    var tool = botConf.get('tools:' + toolName);

    console.log('Changing to tool: ' + toolName);

    // Set the height based on what kind of tool it is
    // TODO: fold this into bot specific tool change logic
    var downHeight = toolName.indexOf('water') != -1 ? 'wash' : 'draw';

    // Pen Up
    setHeight('up');

    // Move to the tool
    movePenAbs(tool);

    // "wait" tools need user feedback to let cncserver know that it can continue
    if (typeof tool.wait != "undefined") {

      if (callback){
        run('callback', callback);
      }

      // Pause or resume continued execution based on tool.wait value
      // In theory: a wait tool has a complementary resume tool to bring it back
      if (tool.wait) {
        bufferPaused = true;
      } else {
        bufferPaused = false;
        executeNext();
      }

    } else { // "Standard" WaterColorBot toolchange
      // Pen down
      setHeight(downHeight);

      // Wiggle the brush a bit
      wigglePen(tool.wiggleAxis, tool.wiggleTravel, tool.wiggleIterations);

      // Put the pen back up when done!
      setHeight('up');

      if (callback){
        run('callback', callback);
      }
    }
  }

  // Move the Pen to an absolute point in the entire work area
  // Returns distance moved, in steps
  function movePenAbs(point, callback, immediate, skipBuffer) {

    // If skipping the buffer, we have to start the pen off at its actual state
    if (skipBuffer) pen = extend({}, actualPen);

    // Something really bad happened here...
    if (isNaN(point.x) || isNaN(point.y)){
      console.error('INVALID Move pen input, given:', point);
      if (callback) callback(false);
      return 0;
    }

    // Sanity check absolute position input point
    point.x = Number(point.x) > BOT.maxArea.width ? BOT.maxArea.width : point.x;
    point.x = Number(point.x) < 0 ? 0 : point.x;

    point.y = Number(point.y) > BOT.maxArea.height ? BOT.maxArea.height : point.y;
    point.y = Number(point.y) < 0 ? 0 : point.y;

    var change = {
      x: Math.round(point.x - pen.x),
      y: Math.round(point.y - pen.y)
    }

    // Don't do anything if there's no change
    if (change.x == 0 && change.y == 0) {
      if (callback) callback(true);
      return 0;
    }

    var distance = Math.sqrt( Math.pow(change.x, 2) + Math.pow(change.y, 2));
    var speed = pen.state ? botConf.get('speed:drawing') : botConf.get('speed:moving');
      speed = (speed/100) * botConf.get('speed:max'); // Convert to steps from percentage

      // Sanity check speed value
      speed = speed > botConf.get('speed:max') ? botConf.get('speed:max') : speed;
      speed = speed < botConf.get('speed:min') ? botConf.get('speed:min') : speed;

    var duration = Math.abs(Math.round(distance / speed * 1000)); // How many steps a second?

    // Don't pass a duration of 0! Makes the EBB DIE!
    if (duration == 0) duration = 1;

    // Save the duration state
    pen.lastDuration = duration;

    pen.x = point.x;
    pen.y = point.y;

    if (botConf.get('controller').position == "relative") {
      // Invert X or Y to match stepper direction
      change.x = gConf.get('invertAxis:x') ? change.x * -1 : change.x;
      change.y = gConf.get('invertAxis:y') ? change.y * -1 : change.y;
    } else { // Absolute! Just use the "new" absolute X & Y locations
      change.x = pen.x;
      change.y = pen.y;
    }

    // Swap motor positions
    if (gConf.get('swapMotors')) {
      change = {
        x: change.y,
        y: change.x
      }
    }

    // Queue the final serial command
    run('move', {x: change.x, y: change.y}, duration, skipBuffer);

    if (callback) {
      if (immediate == 1) {
        callback(1);
      } else {
        // Set the timeout to occur sooner so the next command will execute
        // before the other is actually complete. This will push into the buffer
        // and allow for far smoother move runs.

        var cmdDuration = Math.max(duration - gConf.get('bufferLatencyOffset'), 0);

        if (cmdDuration < 2) {
          callback(1);
        } else {
          setTimeout(function(){callback(1);}, cmdDuration);
        }

      }
    }

    return distance;
  }

  // Wiggle Pen for WCB toolchanges
  function wigglePen(axis, travel, iterations){
    var start = {x: Number(pen.x), y: Number(pen.y)};
    var i = 0;
    travel = Number(travel); // Make sure it's not a string

    // Start the wiggle!
    _wiggleSlave(true);

    function _wiggleSlave(toggle){
      var point = {x: start.x, y: start.y};

      if (axis == 'xy') {
        var rot = i % 4; // Ensure rot is always 0-3

        // This confuluted series ensure the wiggle moves in a proper diamond
        if (rot % 3) { // Results in F, T, T, F
          if (toggle) {
            point.y+= travel/2; // Down
          } else {
            point.x-= travel; // Left
          }
        } else {
           if (toggle) {
             point.y-= travel/2; // Up
           } else {
             point.x+= travel; // Right
           }
        }
      } else {
        point[axis]+= (toggle ? travel : travel * -1);
      }

      movePenAbs(point);

      i++;

      if (i <= iterations){ // Wiggle again!
        _wiggleSlave(!toggle);
      } else { // Done wiggling, go back to start
        movePenAbs(start);
      }
    }
  }
}

// Initialize global config
function loadGlobalConfig(cb) {
  // Pull conf from file
  var configPath = path.resolve(__dirname, 'config.ini');
  gConf.reset();
  gConf.use('file', {
    file: configPath,
    format: nconf.formats.ini
  }).load(cb);

  // Set Global Config Defaults
  gConf.defaults();

  // Save Global Conf file defaults if not saved
  if(!fs.existsSync(configPath)) {
    var def = gConf.stores['defaults'].store;
    for(var key in def) {
      if (key != 'type'){
        gConf.set(key, def[key]);
      }
    }
    gConf.save();
  }

  // Output if debug mode is on
  if (gConf.get('debug')) {
    console.info('== CNCServer Debug mode is ON ==');
  }
};

// Load bot config file based on botType global config
function loadBotConfig(cb, botType) {
  if (!botType) botType = gConf.get('botType');

  var botTypeFile = path.resolve(__dirname, 'machine_types', botType + '.ini');
  if (!fs.existsSync(botTypeFile)){
    console.error('CNC Server bot configuration file "' + botTypeFile + '" doesn\'t exist. Error #16');
    process.exit(16);
  } else {
    botConf.reset();
    botConf.use('file', {
      file: botTypeFile,
      format: nconf.formats.ini
    }).load(cb);
    console.log('Successfully loaded config for ' + botConf.get('name') + '! Initializing...')
  }

  // Mesh in bot overrides from main config
  var overrides = gConf.get('botOverride')[gConf.get('botType')];
  for(var key in overrides) {
    botConf.set(key, overrides[key]);
  }

  BOT = {
    workArea: {
      left: Number(botConf.get('workArea:left')),
      top: Number(botConf.get('workArea:top'))
    },
    maxArea: {
      width: Number(botConf.get('maxArea:width')),
      height: Number(botConf.get('maxArea:height'))
    },
    commands : botConf.get('controller').commands
  }
}

// Utility wrapper for creating and managing standard responses and headers for endpoints
function createServerEndpoint(path, callback){
  var what = Object.prototype.toString;
  app.all(path, function(req, res){
    res.set('Content-Type', 'application/json; charset=UTF-8');
    res.set('Access-Control-Allow-Origin', '*'); // gConf.get('corsDomain')
    // TODO: Why isn't gConf setup yet??   ^^^

    if (gConf.get('debug')) {
      console.log(req.route.method.toUpperCase(), req.route.path, JSON.stringify(req.body));
    }

    var cbStat = callback(req, res);

    if (cbStat === false) { // Super simple "not supported"
      res.status(405).send(JSON.stringify({
        status: 'Not supported'
      }));
    } else if(what.call(cbStat) === '[object Array]') { // Simple return message
      // Array format: [/http code/, /status message/]
      res.status(cbStat[0]).send(JSON.stringify({
        status: cbStat[1]
      }));
    } else if(what.call(cbStat) === '[object Object]') { // Full message
      res.status(cbStat.code).send(JSON.stringify(cbStat.body));
    }
  });
}

// COMMAND RUN QUEUE UTILS ==========================================

// Holds the MS time of the "current" command sent, as this should be limited
// by the run queue, this should only ever refer to what's being sent through.
// the following command will be delayed by this much time.
var commandDuration = 0;

// Add command to serial command runner
function run(command, data, duration, skipBuffer) {
  var c = '';

  // Sanity check duration to minimum of 1, int only
  duration = !duration ? 1 : Math.abs(parseInt(duration));
  duration = duration <= 0 ? 1 : duration;

  switch (command) {
    case 'move':
      c = cmdstr('movexy', {d: duration, x: data.x, y: data.y});
      break;
    case 'height':
      // Send a new setup value for the the up position, then trigger "pen up"
      run('custom', cmdstr('movez', {z: data}), null, skipBuffer);

      // If there's a togglez, run it after setting Z
      if (BOT.commands.togglez) {
        run('custom', cmdstr('togglez', {t: 0}), null, skipBuffer);
      }

      run('wait', '', duration, skipBuffer);
      return;
      break;
    case 'wait':
      // Send wait, blocking buffer
      if (!BOT.commands.wait) return false;
      c = cmdstr('wait', {d: duration});
      break;
    case 'custom':
      c = data;
      break;
    case 'callback': // Custom callback runner for API return triggering
      c = data;
      break;
    default:
      return false;
  }

  // Give the option to completely skip the buffer
  if (skipBuffer && typeof c == 'string') {
    // Set the actualPen state to match the state assumed at the time the buffer
    // item was created
    actualPen = extend({}, pen);
    serialCommand(c);
  } else {
    // Add final command and duration to end of queue, along with a copy of the
    // pen state at this point in time to be copied to actualPen after execution
    buffer.unshift([c, duration, extend({}, pen)]);
  }
}

// Create a bot specific serial command string from values
function cmdstr(name, values) {
  if (!name || !BOT.commands[name]) return ''; // Sanity check

  var out = BOT.commands[name];

  for(var v in values) {
    out = out.replace('%' + v, values[v]);
  }

  return out;
}

// Buffer self-runner
function executeNext() {
  // Run the paused callback if applicable
  if (bufferNewlyPaused) {
    bufferPauseCallback();
  }

  // Don't continue execution if paused
  if (bufferPaused) return;

  if (buffer.length) {
    var cmd = buffer.pop();

    if (typeof cmd[0] === "function") {
      // Run custom callback in the queue. Timing for this should be correct
      // because of commandDuration below! (Here's hoping)
      cmd[0](1);
      executeNext();
    } else {
      // Set the duration of this command so when the board returns "OK",
      // will delay next command send
      commandDuration = Math.max(cmd[1] - gConf.get('bufferLatencyOffset'), 0);

      // Actually send the command out to serial
      serialCommand(cmd[0]);
    }

    // Set the actualPen state to match the state assumed at the time the buffer
    // item was created
    actualPen = extend({}, cmd[2]);

  } else {
    bufferRunning = false;
  }
}

// Buffer interval catcher, starts running the buffer as soon as items exist in it
setInterval(function(){
  if (buffer.length && !bufferRunning && !bufferPaused) {
    bufferRunning = true;
    executeNext();
  }
}, 10);


// SERIAL READ/WRITE ================================================
function serialCommand(command, callback){
  if (!serialPort.write && !pen.simulation) { // Not ready to write to serial!
    if (callback) callback(true);
    return;
  }

  if (gConf.get('debug')) {
    var word = !pen.simulation ? 'Executing' : 'Simulating';
    console.log(word + ' serial command: ' + command);
  }

  // Not much error catching.. but.. really, when does that happen?!
  if (!pen.simulation) {
    serialPort.write(command + "\r");
  } else {
    // Trigger next command as we're simulating and would never receive the ACK
    serialReadline(botConf.get('controller').ack);
  }

  if (callback) callback(true);
}

// READ (Initialized on connect)
function serialReadline(data) {
  if (data.trim() == botConf.get('controller').ack) {
    // Trigger the next buffered command (after its intended duration)
    if (commandDuration < 2) {
      executeNext();
    } else {
      setTimeout(executeNext, commandDuration);
    }

  } else {
    console.error('Message From Controller: ' + data);
    executeNext(); // Error, but continue anyways
  }
}

// Event callback for serial close
function serialPortCloseCallback() {
  console.log('Serialport connection to "' + gConf.get('serialPath') + '" lost!! Did it get unplugged?');
  serialPort = false;

  // Assume the last serialport isn't coming back for a while... a long vacation
  gConf.set('serialPath', '');
  simulationModeInit();
}

// Helper to initialize simulation mode
function simulationModeInit() {
  console.log("=======Continuing in SIMULATION MODE!!!============");
  pen.simulation = 1;
}

// Helper function to manage initial serial connection and reconnection
function connectSerial(options){
  var autoDetect = false;
  var stat = false;

  // Attempt to auto detect EBB Board via PNPID
  if (gConf.get('serialPath') == "" || gConf.get('serialPath') == '{auto}') {
    autoDetect = true;
    console.log('Finding available serial ports...');
  } else {
    console.log('Using passed serial port "' + gConf.get('serialPath') + '"...');
  }

  require("serialport").list(function (err, ports) {
    var portNames = ['None'];
    console.log('Full Available Port Data:', ports);
    for (var portID in ports){
      portNames[portID] = ports[portID].comName;

      // Sanity check manufacturer (returns undefined for some devices in Serialport 1.2.5)
      if (typeof ports[portID].manufacturer != 'string') {
        ports[portID].manufacturer = '';
      }

      // Specific board detect for linux
      if (ports[portID].pnpId.indexOf(botConf.get('controller').name) !== -1 && autoDetect) {
        gConf.set('serialPath', portNames[portID]);
      // All other OS detect
      } else if (ports[portID].manufacturer.indexOf(botConf.get('controller').manufacturer) !== -1 && autoDetect) {
        gConf.set('serialPath', portNames[portID]);
      }
    }

    console.log('Available Serial ports: ' + portNames.join(', '));

    // Try to connect to serial, or exit with error codes
    if (gConf.get('serialPath') == "" || gConf.get('serialPath') == '{auto}') {
      console.log(botConf.get('controller').name + " not found. Are you sure it's connected? Error #22");
      if (options.error) options.error(botConf.get('controller').name + ' not found.');
    } else {
      console.log('Attempting to open serial port: "' + gConf.get('serialPath') + '"...');
      try {
        serialPort = new SerialPort(gConf.get('serialPath'), {
          baudrate : Number(botConf.get('controller').baudRate),
          parser: serialport.parsers.readline("\r")
        });

        if (options.connect) serialPort.on("open", options.connect);
        if (options.disconnect) serialPort.on("close", options.disconnect);

        console.log('Serial connection open at ' + botConf.get('controller').baudRate + 'bps');
        pen.simulation = 0;
        if (options.success) options.success();
      } catch(e) {
        console.log("Serial port failed to connect. Is it busy or in use? Error #10");
        console.log('SerialPort says:', e);
        if (options.error) options.error(e);
      }
    }

    // Complete callback
    if (options.complete) options.complete(stat);
  });
}
