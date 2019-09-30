var mongoose = require('mongoose')
  , db = require('../lib/database')
  , Tx = require('../models/tx')  
  , Address = require('../models/address')  
  , Richlist = require('../models/richlist')  
  , Stats = require('../models/stats')  
  , settings = require('../lib/settings')
  , fs = require('fs');

var mode = 'update';
var database = 'index';

// displays usage and exits
function usage() {
  console.log('Usage: node scripts/sync.js [database] [mode]');
  console.log('');
  console.log('database: (required)');
  console.log('index [mode] Main index: coin info/stats, transactions & addresses');
  console.log('market       Market data: summaries, orderbooks, trade history & chartdata')
  console.log('');
  console.log('mode: (required for index database only)');
  console.log('update       Updates index from last sync to current block');
  console.log('check        checks index for (and adds) any missing transactions/addresses');
  console.log('reindex      Clears index then resyncs from genesis to current block');
  console.log('');
  console.log('notes:'); 
  console.log('* \'current block\' is the latest created block when script is executed.');
  console.log('* The market database only supports (& defaults to) reindex mode.');
  console.log('* If check mode finds missing data(ignoring new data since last sync),'); 
  console.log('  index_timeout in settings.json is set too low.')
  console.log('');
  process.exit(0);
}

if (process.platform == 'win32') {
	var rl = require('readline').createInterface({
		input: process.stdin,
		output: process.stdout
	});
	
	rl.on('SIGINT', function() {
		process.emit('SIGINT');
	});
}

process.on('SIGINT', function() {
	exit();
});

// check options
if (process.argv[2] == 'index') {
  if (process.argv.length <3) {
    usage();
  } else {
    switch(process.argv[3])
    {
    case 'update':
      mode = 'update';
      break;
    case 'check':
      mode = 'check';
      break;
    case 'reindex':
      mode = 'reindex';
      break;
    default:
      usage();
    }
  }
} else if (process.argv[2] == 'market'){
  database = 'market';
} else {
  usage();
}

function create_lock(cb) {
  if ( database == 'index' ) {
    var fname = './tmp/' + database + '.pid';
    fs.appendFile(fname, process.pid, function (err) {
      if (err) {
        console.log("Error: unable to create %s", fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }
}

function remove_lock(cb) {
  if ( database == 'index' ) {
    var fname = './tmp/' + database + '.pid';
    fs.unlink(fname, function (err){
      if(err) {
        console.log("unable to remove lock: %s", fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }  
}

function is_locked(cb) {
  if ( database == 'index' ) {
    var fname = './tmp/' + database + '.pid';
    fs.exists(fname, function (exists){
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  } else {
    return cb();
  } 
}

function exit() {
  remove_lock(function(){
    mongoose.disconnect();
    process.exit(0);
  });
}

var dbString = 'mongodb://' + settings.dbsettings.user;
dbString = dbString + ':' + settings.dbsettings.password;
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;



// ---------------------------------> DB Functions
function dbRunUpdate() {
	db.update_db(settings.coin, function(){
		db.get_stats(settings.coin, function(stats){
		  /*if (settings.heavy == true) {
			db.update_heavy(settings.coin, stats.count, 20, function(){
			});
		  }*/
		  if (mode == 'reindex') {
			dbReindex(stats);          
		  } else if (mode == 'check') {
			dbCheck(stats);
		  } else if (mode == 'update') {
			dbUpdate(stats);
		  }
		});
	});
}

function dbReindex(stats) {
	Tx.remove({}, function(err) { 
		Address.remove({}, function(err2) { 
		  Richlist.update({coin: settings.coin}, {
			received: [],
			balance: [],
		  }, function(err3) { 
			Stats.update({coin: settings.coin}, { 
			  last: 0,
			}, function() {
			  console.log('index cleared (reindex)');
			}); 
			db.update_tx_db(settings.coin, 1, stats.count, settings.update_timeout, function(){
			  db.update_richlist('received', function(){
				db.update_richlist('balance', function(){
				  db.get_stats(settings.coin, function(nstats){
					console.log('reindex complete (block: %s)', nstats.last);
					exit();
				  });
				});
			  });
			});
		  });
		});
	});
}

function dbCheck(stats) {
	db.update_tx_db(settings.coin, 1, stats.count, settings.check_timeout, function(){
		db.get_stats(settings.coin, function(nstats){
		  console.log('check complete (block: %s)', nstats.last);
		  exit();
		});
	});
}

function dbUpdate(stats) {
	var start = stats.last
	
	if (settings.start_block > 0 && settings.start_block > start) {
		start = settings.start_block;
	}
	
	db.update_tx_db(settings.coin, start, stats.count, settings.update_timeout, function(){
		db.update_richlist('received', function(){
		  db.update_richlist('balance', function(){
			db.get_stats(settings.coin, function(nstats){
			  console.log('update complete (block: %s)', nstats.last);
//			  exit();
			  dbUpdateMempool();
			});
		  });
		});
	});
}

function dbUpdateMempool() {
	db.update_mempool_db(settings.update_timeout, function() {
		db.update_mined_blocks_db(settings.update_timeout, function() {
			setTimeout(function() {
				dbUpdateMempool();
			}, settings.update_rerun_timeout);
		});
	});
}
// DB Functions <---------------------------------


is_locked(function (exists) {
  if (exists) {
    console.log("Script already running..");
    process.exit(0);
  } else {
    create_lock(function (){
      console.log("script launched with pid: " + process.pid);
      mongoose.connect(dbString, function(err) {
        if (err) {
          console.log('Unable to connect to database: %s', dbString);
          console.log('Aborting');
          exit();
        } else if (database == 'index') {
          db.check_stats(settings.coin, function(exists) {
            if (exists == false) {
              console.log('Run \'npm start\' to create database structures before running this script.');
              exit();
            } else {
			  dbRunUpdate();
            }
          });
        } else {
          //update markets
          var markets = settings.markets.enabled;
          var complete = 0;
          for (var x = 0; x < markets.length; x++) {
            var market = markets[x];
            db.check_market(market, function(mkt, exists) {
              if (exists) {
                db.update_markets_db(mkt, function(err) {
                  if (!err) {
                    console.log('%s market data updated successfully.', mkt);
                    complete++;
                    if (complete == markets.length) {
                      exit();
                    }
                  } else {
                    console.log('%s: %s', mkt, err);
                    complete++;
                    if (complete == markets.length) {
                      exit();
                    }
                  }
                });
              } else {
                console.log('error: entry for %s does not exists in markets db.', mkt);
                complete++;
                if (complete == markets.length) {
                  exit();
                }
              }
            });
          }
        }
      });
    });
  }
});