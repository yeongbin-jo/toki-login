


// For background page



/******************************************************************************/

(function() {

'use strict';

/******************************************************************************/

var vAPI = self.vAPI = self.vAPI || {};

var chrome = self.chrome;
var manifest = chrome.runtime.getManifest();

vAPI.chrome = true;

var noopFunc = function(){};

/******************************************************************************/

vAPI.app = {
    name: manifest.name,
    version: manifest.version
};

/******************************************************************************/

if ( !chrome.runtime ) {
    // Chrome 20-21
    chrome.runtime = chrome.extension;
} else if ( !chrome.runtime.onMessage ) {
    // Chrome 22-25
    chrome.runtime.onMessage = chrome.extension.onMessage;
    chrome.runtime.sendMessage = chrome.extension.sendMessage;
    chrome.runtime.onConnect = chrome.extension.onConnect;
    chrome.runtime.connect = chrome.extension.connect;
}

/******************************************************************************/

vAPI.app.restart = function() {
    chrome.runtime.reload();
};

/******************************************************************************/

// chrome.storage.local.get(null, function(bin){ console.debug('%o', bin); });

//console.log("Setting storage ")
vAPI.storage = chrome.storage.local;
vAPI.storage.preferences = vAPI.storage;

/******************************************************************************/

vAPI.tabs = {};

/******************************************************************************/

vAPI.isBehindTheSceneTabId = function(tabId) {
    return tabId.toString() === '-1';
};

vAPI.noTabId = '-1';



/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/101
// chrome API expects tab id to be a number, not a string.

var toChromiumTabId = function(tabId) {
    if ( typeof tabId === 'string' ) {
        tabId = parseInt(tabId, 10);
    }
    if ( typeof tabId !== 'number' || isNaN(tabId) || tabId === -1 ) {
        return 0;
    }
    return tabId;
};

/******************************************************************************/

vAPI.tabs.registerListeners = function() {
    var onNavigationClient = this.onNavigation || noopFunc;
    var onPopupClient = this.onPopup || noopFunc;
    var onUpdatedClient = this.onUpdated || noopFunc;
    var onClosedClient = this.onClosed || noopFunc;

    // https://developer.chrome.com/extensions/webNavigation
    // [onCreatedNavigationTarget ->]
    //  onBeforeNavigate ->
    //  onCommitted ->
    //  onDOMContentLoaded ->
    //  onCompleted

    var popupCandidates = Object.create(null);

    var PopupCandidate = function(details) {
        this.targetTabId = details.tabId.toString();
        this.openerTabId = details.sourceTabId.toString();
        this.targetURL = details.url;
        this.selfDestructionTimer = null;
    };

    PopupCandidate.prototype.selfDestruct = function() {
        if ( this.selfDestructionTimer !== null ) {
            clearTimeout(this.selfDestructionTimer);
        }
        delete popupCandidates[this.targetTabId];
    };

    PopupCandidate.prototype.launchSelfDestruction = function() {
        if ( this.selfDestructionTimer !== null ) {
            clearTimeout(this.selfDestructionTimer);
        }
        this.selfDestructionTimer = setTimeout(this.selfDestruct.bind(this), 10000);
    };

    var popupCandidateCreate = function(details) {
        var popup = popupCandidates[details.tabId];
        // This really should not happen...
        if ( popup !== undefined ) {
            return;
        }
        return popupCandidates[details.tabId] = new PopupCandidate(details);
    };

    var popupCandidateTest = function(details) {
        var popup = popupCandidates[details.tabId];
        if ( popup === undefined ) {
            return;
        }
        popup.targetURL = details.url;
        if ( onPopupClient(popup) !== true ) {
            return;
        }
        popup.selfDestruct();
        return true;
    };

    var popupCandidateDestroy = function(details) {
        var popup = popupCandidates[details.tabId];
        if ( popup instanceof PopupCandidate ) {
            popup.launchSelfDestruction();
        }
    };

    // The chrome.webRequest.onBeforeRequest() won't be called for everything
    // else than `http`/`https`. Thus, in such case, we will bind the tab as
    // early as possible in order to increase the likelihood of a context
    // properly setup if network requests are fired from within the tab.
    // Example: Chromium + case #6 at
    //          http://raymondhill.net/ublock/popup.html
    var reGoodForWebRequestAPI = /^https?:\/\//;

    var onCreatedNavigationTarget = function(details) {
        //console.debug('onCreatedNavigationTarget: popup candidate tab id %d = "%s"', details.tabId, details.url);
        if ( reGoodForWebRequestAPI.test(details.url) === false ) {
            details.frameId = 0;
            onNavigationClient(details);
        }
        popupCandidateCreate(details);
        popupCandidateTest(details);
    };

    var onBeforeNavigate = function(details) {
        if ( details.frameId !== 0 ) {
            return;
        }
        //console.debug('onBeforeNavigate: popup candidate tab id %d = "%s"', details.tabId, details.url);
        popupCandidateTest(details);
    };

    var onUpdated = function(tabId, changeInfo, tab) {
        if ( changeInfo.url && popupCandidateTest({ tabId: tabId, url: changeInfo.url }) ) {
            return;
        }
        onUpdatedClient(tabId, changeInfo, tab);
    };

    var onCommitted = function(details) {
        if ( details.frameId !== 0 ) {
            return;
        }
        onNavigationClient(details);
        delete vAPI.iconStateForTabId[details.tabId];
        //console.debug('onCommitted: popup candidate tab id %d = "%s"', details.tabId, details.url);
        if ( popupCandidateTest(details) === true ) {
            return;
        }
        popupCandidateDestroy(details);
    };
    var onClosed = function(tabId) {
        delete vAPI.iconStateForTabId[tabId];
        onClosedClient(tabId);
    };

    //chrome.webNavigation.onCreatedNavigationTarget.addListener(onCreatedNavigationTarget);
    //chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    //chrome.webNavigation.onCommitted.addListener(onCommitted);
	//console.log("Adding updated listener")
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onClosed);
};

/******************************************************************************/

vAPI.tabs.get = function(tabId, callback) {
    var onTabReady = function(tab) {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( chrome.runtime.lastError ) {
            /* noop */
        }
        // Caller must be prepared to deal with nil tab value
        callback(tab);
    };

    if ( tabId !== null ) {
        tabId = toChromiumTabId(tabId);
        if ( tabId === 0 ) {
            onTabReady(null);
        } else {
            chrome.tabs.get(tabId, onTabReady);
        }
        return;
    }

    var onTabReceived = function(tabs) {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( chrome.runtime.lastError ) {
            /* noop */
        }
        callback(tabs[0]);
    };
    chrome.tabs.query({ active: true, currentWindow: true }, onTabReceived);
};

/******************************************************************************/

// properties of the details object:
//   url: 'URL', // the address that will be opened
//   tabId: 1, // the tab is used if set, instead of creating a new one
//   index: -1, // undefined: end of the list, -1: following tab, or after index
//   active: false, // opens the tab in background - true and undefined: foreground
//   select: true // if a tab is already opened with that url, then select it instead of opening a new one

vAPI.tabs.open = function(details) {
    var targetURL = details.url;
    if ( typeof targetURL !== 'string' || targetURL === '' ) {
        return null;
    }
    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    // dealing with Chrome's asynchronous API
    var wrapper = function() {
        if ( details.active === undefined ) {
            details.active = true;
        }

        var subWrapper = function() {
            var _details = {
                url: targetURL,
                active: !!details.active
            };

            // Opening a tab from incognito window won't focus the window
            // in which the tab was opened
            var focusWindow = function(tab) {
                if ( tab.active ) {
                    chrome.windows.update(tab.windowId, { focused: true });
                }
            };

            if ( !details.tabId ) {
                if ( details.index !== undefined ) {
                    _details.index = details.index;
                }

                chrome.tabs.create(_details, focusWindow);
                return;
            }

            // update doesn't accept index, must use move
            chrome.tabs.update(toChromiumTabId(details.tabId), _details, function(tab) {
                // if the tab doesn't exist
                if ( vAPI.lastError() ) {
                    chrome.tabs.create(_details, focusWindow);
                } else if ( details.index !== undefined ) {
                    chrome.tabs.move(tab.id, {index: details.index});
                }
            });
        };

        if ( details.index !== -1 ) {
            subWrapper();
            return;
        }

        vAPI.tabs.get(null, function(tab) {
            if ( tab ) {
                details.index = tab.index + 1;
            } else {
                delete details.index;
            }

            subWrapper();
        });
    };

    if ( !details.select ) {
        wrapper();
        return;
    }

    chrome.tabs.query({ url: targetURL }, function(tabs) {
        var tab = tabs[0];
        if ( tab ) {
            chrome.tabs.update(tab.id, { active: true }, function(tab) {
                chrome.windows.update(tab.windowId, { focused: true });
            });
        } else {
            wrapper();
        }
    });
};

/******************************************************************************/

// Replace the URL of a tab. Noop if the tab does not exist.

vAPI.tabs.replace = function(tabId, url) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var targetURL = url;

    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    chrome.tabs.update(tabId, { url: targetURL }, function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( chrome.runtime.lastError ) {
            /* noop */
        }
    });
};

/******************************************************************************/

vAPI.tabs.remove = function(tabId) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var onTabRemoved = function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( chrome.runtime.lastError ) {
            /* noop */
        }
    };

    chrome.tabs.remove(tabId, onTabRemoved);
};

/******************************************************************************/

vAPI.tabs.reload = function(tabId /*, flags*/) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var onReloaded = function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( chrome.runtime.lastError ) {
            /* noop */
        }
    };

    chrome.tabs.reload(tabId, onReloaded);
};

/******************************************************************************/

vAPI.tabs.injectScript = function(tabId, details, callback) {

    var onScriptExecuted = function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( chrome.runtime.lastError ) {
            /* noop */
        }
        if ( typeof callback === 'function' ) {
            callback();
        }
    };
    if ( tabId ) {
        chrome.tabs.executeScript(toChromiumTabId(tabId), details, onScriptExecuted);
    } else {
        chrome.tabs.executeScript(details, onScriptExecuted);
    }
};

/******************************************************************************/

var IconState = function(badge, img) {
    this.badge = badge;
        // ^ a number -- the badge 'value'
    this.img = img;
        // ^ a string -- 'on' or 'off'
    this.dirty = (1 << 1) | (1 << 0);
        /* ^ bitmask AB: two bits, A and B
                where A is whether img has changed and needs render
                and B is whether badge has changed and needs render */
};
vAPI.iconStateForTabId = {}; // {tabId: IconState}


var AUTOLOGIN_ICON_PATHS = {
"whitelist":{'38': 'img/browsericons/autologinLogoWhite38.png','19': 'img/browsericons/autologinLogoWhite19.png'},
"active":{'38': 'img/browsericons/autologinLogoActive38.png','19': 'img/browsericons/autologinLogoActive19.png'},
"off":{'38': 'img/browsericons/autologinLogoRed38.png','19': 'img/browsericons/autologinLogoRed19.png'},
"init":{'38': 'img/browsericons/autologinLogoInit38.png','19': 'img/browsericons/autologinLogoInit19.png'}

}


/*
var ICON_PATHS = {
    "on": { '19': 'img/browsericons/icon19.png',     '38': 'img/browsericons/icon38.png' },
    "off": { '19': 'img/browsericons/icon19-off.png', '38': 'img/browsericons/icon38-off.png' }
};

// Must read: https://code.google.com/p/chromium/issues/detail?id=410868#c8

// https://github.com/chrisaljoudi/uBlock/issues/19
// https://github.com/chrisaljoudi/uBlock/issues/207
// Since we may be called asynchronously, the tab id may not exist
// anymore, so this ensures it does still exist.

vAPI.setIcon = function(tabId, iconStatus, badge) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var onIconReady = function() {
        if ( vAPI.lastError() ) {
            return;
        }
        chrome.browserAction.setBadgeText({ tabId: tabId, text: badge });
        chrome.browserAction.setBadgeBackgroundColor({
            tabId: tabId,
            color: '#666'
        });
    };
    var state = vAPI.iconStateForTabId[tabId];
    if(typeof state === "undefined") {
        state = vAPI.iconStateForTabId[tabId] = new IconState(badge, iconStatus);
    }
    else {
        state.dirty = ((state.badge !== badge) << 1) | ((state.img !== iconStatus) << 0);
        state.badge = badge;
        state.img = iconStatus;
    }
    if(state.dirty & 1) { // got a new icon?
        chrome.browserAction.setIcon({ tabId: tabId, path: ICON_PATHS[iconStatus] }, onIconReady);
    }
    else if(state.dirty & 2) {
        chrome.browserAction.setBadgeText({ tabId: tabId, text: badge });
    }
};
*/
/******************************************************************************/

vAPI.setAutologinIcon = function(tabId, detail) {
	
	var iconStatus=detail.status
	var badge=detail.badge
	var label=detail.label
	
	
    tabId = vAPI.tabs.toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var onIconReady = function() {
        if ( vAPI.lastError() ) {
            return;
        }
        chrome.browserAction.setBadgeText({ tabId: tabId, text: badge });
		/*
        chrome.browserAction.setBadgeBackgroundColor({
            tabId: tabId,
            color: '#666'
        });
		*/
    };
	
		
	 chrome.browserAction.setIcon({ tabId: tabId, path: AUTOLOGIN_ICON_PATHS[iconStatus] }, onIconReady);
	chrome.browserAction.setTitle({ tabId: tabId, title: label })
	////console.log("state.img",state.img)
	
	/*
    var state = vAPI.iconStateForTabId[tabId];
    if(typeof state === "undefined") {
        state = vAPI.iconStateForTabId[tabId] = new IconState(badge, iconStatus);
    }
    else {
        state.dirty = ((state.badge !== badge) << 1) | ((state.img !== iconStatus) << 0);
        state.badge = badge;
        state.img = iconStatus;
    }
    if(state.dirty & 1) { // got a new icon?
       
    }
    else if(state.dirty & 2) {
        chrome.browserAction.setBadgeText({ tabId: tabId, text: badge });
    }
*/
};


vAPI.messaging = {
    ports: {},
    listeners: {},
    defaultHandler: null,
    NOOPFUNC: noopFunc,
    UNHANDLED: 'vAPI.messaging.notHandled'
};

/******************************************************************************/

vAPI.messaging.listen = function(listenerName, callback) {
    this.listeners[listenerName] = callback;
};

/******************************************************************************/

vAPI.messaging.onPortMessage = function(request, port) {
    var callback = vAPI.messaging.NOOPFUNC;
    if ( request.requestId !== undefined ) {
        callback = CallbackWrapper.factory(port, request).callback;
    }

    // Specific handler
    var r = vAPI.messaging.UNHANDLED;
    var listener = vAPI.messaging.listeners[request.channelName];
    if ( typeof listener === 'function' ) {
        r = listener(request.msg, port.sender, callback);
    }
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    // Default handler
    r = vAPI.messaging.defaultHandler(request.msg, port.sender, callback);
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    console.error('AppExtn> messaging > unknown request: %o', request);

    // Unhandled:
    // Need to callback anyways in case caller expected an answer, or
    // else there is a memory leak on caller's side
    callback();
};

/******************************************************************************/

vAPI.messaging.onPortDisconnect = function(port) {
    port.onDisconnect.removeListener(vAPI.messaging.onPortDisconnect);
    port.onMessage.removeListener(vAPI.messaging.onPortMessage);
    delete vAPI.messaging.ports[port.name];
};

/******************************************************************************/

vAPI.messaging.onPortConnect = function(port) {
    port.onDisconnect.addListener(vAPI.messaging.onPortDisconnect);
    port.onMessage.addListener(vAPI.messaging.onPortMessage);
    vAPI.messaging.ports[port.name] = port;
};

/******************************************************************************/

vAPI.messaging.setup = function(defaultHandler) {
    // Already setup?
    if ( this.defaultHandler !== null ) {
        return;
    }

    if ( typeof defaultHandler !== 'function' ) {
        defaultHandler = function(){ return vAPI.messaging.UNHANDLED; };
    }
    this.defaultHandler = defaultHandler;

    chrome.runtime.onConnect.addListener(this.onPortConnect);
};

/******************************************************************************/

vAPI.messaging.broadcast = function(message) {
    var messageWrapper = {
        broadcast: true,
        msg: message
    };

    for ( var portName in this.ports ) {
        if ( this.ports.hasOwnProperty(portName) === false ) {
            continue;
        }
        this.ports[portName].postMessage(messageWrapper);
    }
};

/******************************************************************************/

// This allows to avoid creating a closure for every single message which
// expects an answer. Having a closure created each time a message is processed
// has been always bothering me. Another benefit of the implementation here
// is to reuse the callback proxy object, so less memory churning.
//
// https://developers.google.com/speed/articles/optimizing-javascript
// "Creating a closure is significantly slower then creating an inner
//  function without a closure, and much slower than reusing a static
//  function"
//
// http://hacksoflife.blogspot.ca/2015/01/the-four-horsemen-of-performance.html
// "the dreaded 'uniformly slow code' case where every function takes 1%
//  of CPU and you have to make one hundred separate performance optimizations
//  to improve performance at all"
//
// http://jsperf.com/closure-no-closure/2

var CallbackWrapper = function(port, request) {
    // No need to bind every single time
    this.callback = this.proxy.bind(this);
    this.messaging = vAPI.messaging;
    this.init(port, request);
};

CallbackWrapper.junkyard = [];

CallbackWrapper.factory = function(port, request) {
    var wrapper = CallbackWrapper.junkyard.pop();
    if ( wrapper ) {
        wrapper.init(port, request);
        return wrapper;
    }
    return new CallbackWrapper(port, request);
};

CallbackWrapper.prototype.init = function(port, request) {
    this.port = port;
    this.request = request;
};

CallbackWrapper.prototype.proxy = function(response) {
    // https://github.com/chrisaljoudi/uBlock/issues/383
    if ( this.messaging.ports.hasOwnProperty(this.port.name) ) {
        this.port.postMessage({
            requestId: this.request.requestId,
            channelName: this.request.channelName,
            msg: response !== undefined ? response : null
        });
    }
    // Mark for reuse
    this.port = this.request = null;
    CallbackWrapper.junkyard.push(this);
};

/******************************************************************************/

vAPI.net = {};

/******************************************************************************/

vAPI.net.registerListeners = function() {
    var ??b = AppExtn;
    var ??buri = ??b.URI;

    var normalizeRequestDetails = function(details) {
        ??buri.set(details.url);

        details.tabId = details.tabId.toString();
        details.hostname = ??buri.hostnameFromURI(details.url);

        // The rest of the function code is to normalize type
        if ( details.type !== 'other' ) {
            return;
        }

        var tail = ??buri.path.slice(-6);
        var pos = tail.lastIndexOf('.');

        // https://github.com/chrisaljoudi/uBlock/issues/862
        // If no transposition possible, transpose to `object` as per
        // Chromium bug 410382 (see below)
        if ( pos === -1 ) {
            details.type = 'object';
            return;
        }

        var ext = tail.slice(pos) + '.';
        if ( '.eot.ttf.otf.svg.woff.woff2.'.indexOf(ext) !== -1 ) {
            details.type = 'font';
            return;
        }
        // Still need this because often behind-the-scene requests are wrongly
        // categorized as 'other'
        if ( '.ico.png.gif.jpg.jpeg.webp.'.indexOf(ext) !== -1 ) {
            details.type = 'image';
            return;
        }
        // https://code.google.com/p/chromium/issues/detail?id=410382
        details.type = 'object';
    };

   

};

/******************************************************************************/
  
  
vAPI.contextMenu = {
	menus:[],
	handleContextMenu:function(info,curtab){
	
		
		var index=vAPI.contextMenu.getMenuIndex(info.menuItemId)
		
		if(index > -1){
			
			var menu=vAPI.contextMenu.menus[index]
			var details=menu["details"]			
			var callback=menu["callback"]	
			
			
			if(callback && typeof callback === 'function'){
			
				callback(info,curtab)
			}
			
			}
				
	},
    create: function(details, callback) {
    
	
		//Handle inappropriate variables
		if(details.isParent)
			delete details.isParent
			
       var uuid= chrome.contextMenus.create(details);
	   
	   vAPI.contextMenu.menus.push({"callback":callback,"details":details,"id":uuid})	
      
    },
    removeAll: function() {
		
       
	   vAPI.contextMenu.menus=[]
			
			chrome.contextMenus.removeAll(function(){
			
			} )
					
		
    },
	getMenuIndex:function(menuId){
		for(var  i=0;i<vAPI.contextMenu.menus.length;i++){
		var details=vAPI.contextMenu.menus[i]["details"]
				
				
				if(details.id == menuId)
					return i
		}
		return -1;
	
	},
	disabledmenus:[],
	getDisabledMenuIndex:function(menuId){
		for(var i=0;i<vAPI.contextMenu.disabledmenus.length;i++){
			var details=vAPI.contextMenu.disabledmenus[i]["details"]
				
				if(details.id == menuId)
					return i
		}
		return -1;
	
	},
	hide: function(menuId) {
	
		var index=vAPI.contextMenu.getMenuIndex(menuId)
		if(index > -1){
			
			vAPI.contextMenu.disabledmenus.push(vAPI.contextMenu.menus[index])
			this.remove(menuId)
		}
	},
	show: function(menuId) {
	
		var index=this.getDisabledMenuIndex(menuId)
		if(index > -1){
			
			//vAPI.contextMenu.disabledmenus.push(vAPI.contextMenu.menus[index])
			//this.remove(menuId)
			var menu=vAPI.contextMenu.disabledmenus[index]
			var details=menu["details"]
			var callback=menu["callback"]
			vAPI.contextMenu.create(details, callback)
			 vAPI.contextMenu.disabledmenus.splice(index,1);
		}
		
	},
	changeLabel: function(menuId,label) {
	
		var index=vAPI.contextMenu.getMenuIndex(menuId)
		
		if(index > -1){
			
			var menu=vAPI.contextMenu.menus[index]
			var details=menu["details"]
			details.title=label
			var callback=menu["callback"]			
			vAPI.contextMenu.remove(menuId)		
			vAPI.contextMenu.create(details, callback)
		}
	},
	remove: function(menuId) {
	
	var index=vAPI.contextMenu.getMenuIndex(menuId)
		if(index > -1){
		
		
			var details=vAPI.contextMenu.menus[index]["details"]
			
			chrome.contextMenus.onClicked.removeListener(vAPI.contextMenu.menus[index]["callback"]);
			chrome.contextMenus.remove(details.id);
			 vAPI.contextMenu.menus.splice(index,1);
		}
    }
};


//chrome.contextMenus.onClicked.addListener(vAPI.contextMenu.handleContextMenu);
/******************************************************************************/

vAPI.lastError = function() {
    return chrome.runtime.lastError;
};

/******************************************************************************/

// This is called only once, when everything has been loaded in memory after
// the extension was launched. It can be used to inject content scripts
// in already opened web pages, to remove whatever nuisance could make it to
// the web pages before uBlock was ready.

vAPI.onLoadAllCompleted = function() {
    // http://code.google.com/p/chromium/issues/detail?id=410868#c11
    // Need to be sure to access `vAPI.lastError()` to prevent
    // spurious warnings in the console.
    var scriptDone = function() {
        vAPI.lastError();
    };
    var scriptEnd = function(tabId) {
        if ( vAPI.lastError() ) {
            return;
        }

		
     

		}
		
		
		 
		
		
		
	
    var scriptStart = function(tab) {
		 
		
        vAPI.tabs.injectScript(tab.id, {
            file: 'js/vapi-client.js',
            allFrames: false,
            runAt: 'document_start'
        }, function(){


				 vAPI.tabs.injectScript(tab.id, {
				file: 'js/utils.js',
				allFrames: false,
				runAt: 'document_start'
			}, function(){


					globalAutologinHandler.processScripts(tab)
					});
		
		
		
		
		
		});
		
 		// Autologin Script
		
	
		
		
		

							
						
		
		
		
		
       
    };
    var bindToTabs = function(tabs) {
        var ??b = AppExtn;
        var i = tabs.length, tab;
        while ( i-- ) {
            tab = tabs[i];
            ??b.tabContextManager.commit(tab.id, tab.url);
            ??b.bindTabToPageStats(tab.id);
         
           scriptStart(tab);
		   
        }
    };

    chrome.tabs.query({ url: 'http://*/*' }, bindToTabs);
    chrome.tabs.query({ url: 'https://*/*' }, bindToTabs);
};

/******************************************************************************/

vAPI.punycodeHostname = function(hostname) {
    return hostname;
};

vAPI.punycodeURL = function(url) {
    return url;
};





///Install update listeners
chrome.runtime.onInstalled.addListener(function(details){
	 
	 var vAPI = self.vAPI = self.vAPI || {};
	  
	  var installData=details || {}
	  
	 
    if((details.reason == "install"  || details.reason == "update" ) ){
      
	  
	  if(installData.previousVersion){
		  
		 
		  installData.existingVersion=installData.previousVersion
		  delete  installData.previousVersion;
	  }
			
		
		installData.installedVersion=manifest.version

		vAPI.handleInstallUpgrade({reason:details.reason,data:installData})
		
		
    }
});


/******************************************************************************/

})();

/******************************************************************************/
