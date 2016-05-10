Components.utils.import("resource://scrapbook-modules/common.jsm");
Components.utils.import("resource://scrapbook-modules/scraprdf.jsm");
Components.utils.import("resource://scrapbook-modules/dirindex.jsm");

/*
Scrapbook FS data source.
Original Scrapbook used RDF file as a data source. Outside modules still require RDF, so we keep one for them.
They interact with us by calling predefined functions which take URNs or RDF-resources.
URNs:
  urn:scrapbook:root
  urn:scrapbook:item12345678901234

Internally we keep the data in a set of Resource() objects. These Resources update the RDF as they're changed.
There's a map URN -> Resource(), so the first thing exported functions do is retrieve the Resource.

Therefore we have three data structures used throughout the SB:
  1. JS container with properties. This is a static structure; data is read into it by getItem(),
    and written back with setItem().
  2. RDF resource / URN.
  3. Resource().

Each Resource has its own underlying FS format:
  root,folder -> folder
  note -> txt
  bookmark -> url
  saved page -> mht
  separator -> none

Some of these formats can store additional properties (url, mht), others can't. In that case additional
properties are stored in a parent container's index file.



*/

/*
On flushing:
Originally, Scrapbook had one index store in scrapbook.rdf. When anything was modified,
a flush was queued 10 seconds later. (Additional resources on the other hand were written immediately).
In ScrapbookFS each folder has an index store. They're smaller, so we're now writing them immediately.
If it ever feels like a good idea to queue flushes (e.g. for batch operations),
we may implement a flush service:
  sbFlushService.queue(this); //from the container Resource()
*/

/*
TODO:
- Store properties internally for some types of files.
- Support/test creation of notes of various types.
- Support MHT.

*/


/*
Data source.
Handles external calls and filesystem actions (moving, creating, deleting) except for index updates.
*/

var sbDataSource = {

    _firstInit : true,
    _flushTimer : null,
    _needReOutputTree : false,

	nodes : [], 	// flat list of all nodes. Nodes auto-register here
    root : null,    // root node

    get data() {
    	sbCommonUtils.dbg('get data()');
    	if (!this.root) this._init();
    	return sbRDF.data;
    },

    _init : function(aQuietWarning) {
    	sbCommonUtils.dbg('init()');
        if (this._firstInit) {
            this._firstInit = false;
            var obs = Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService);
            obs.addObserver(this, "quit-application-requested", false);
        }
        try {
        	sbCommonUtils.dbg('init: initializing RDF');
            sbRDF.init();
            sbCommonUtils.dbg('init: creating root');
            this.root = new Resource(null, "root", sbCommonUtils.getScrapBookDir());
            this._loadChildren(this.root, this.root._FSO, true);
            sbCommonUtils.dbg('init: tree built');
            this._needReOutputTree = false;
        } catch(ex) {
            if ( !aQuietWarning ) sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_INIT_DATASOURCE", [ex]));
        }
    },

    _uninit : function() {
        if (this._flushTimer) this.flush();
        sbRDF.uninit();
    },



	//Alternatively we may skip files with "hidden" flag set
	IGNORE_FILENAMES : ['index.dat','desktop.ini'],

	//Checks the filesystem and loads all the children elements
	//At this time it can only be used for initial loading, but our final objective is to support reloading:
	//  we'll try to preserve any existing elements, instead reordering them.
    _loadChildren : function(aRes, fso, recursive) {
    	sbCommonUtils.dbg('loadChildren('+fso.path+'): hi children');
    	if (!fso.exists()) return;
    	if (!fso.isDirectory()) return;

		//Load index.dat
		sbCommonUtils.dbg('loadChildren('+fso.path+'): loading index.dat entries');
		aRes._loadingChildren = true;
		var index = aRes._loadIndex(fso);
		sbCommonUtils.dbg("loadChildren: "+index.entries.length+" index entries");
		for (var i=0; i<index.entries.length; i++) {
			var entry = index.entries[i];
			if (entry.id == "") continue; //safety
			sbCommonUtils.dbg("loadChildren: index entry "+entry.id+","+entry.title);
			if (entry.id.startsWith('*')) {
				aRes.insertChild(new Resource(null, "separator"));
				continue;
			}
			if (aRes.indexOfFilename(entry.id) >= 0) continue; //don't list one resource twice

			var childFso = fso.clone();
			childFso.append(entry.id);
			try {
			  var childRes = this._loadResource(childFso, recursive);
			} catch (ex) {
				if (ex.name == "NS_ERROR_FILE_NOT_FOUND") {
					sbCommonUtils.dbg("File not found: "+entry.id+", skipping.");
					continue; //that's okay
				}
				throw ex;
			}
			if (entry.title != "")
				childRes.setCustomTitle(entry.title);
			for (var i=0; i<entry.props.length; i++) {
				sbCommonUtils.dbg("loadChildren: property "+entry.props[i].name);
				childRes._loadExternalProperty(entry.props[i].name, entry.props[i].value);
			}
			aRes.insertChild(childRes);
		}
		
    	//Now load the rest of the directory entries
    	sbCommonUtils.dbg('loadChildren('+fso.path+'): loading the rest of the entries');
    	var entries = fso.directoryEntries;
    	while (entries.hasMoreElements()) {
    		sbCommonUtils.dbg("loadChildren: entry");
    		var entry = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
    		if (entry.isHidden()) {
    			sbCommonUtils.dbg("loadChildren: hidden, skipping");
    			continue; //skip hidden files such as desktop.ini
    		}

    		var filename = entry.leafName;
    		sbCommonUtils.dbg("loadChildren: leafName="+filename);
    		if (this.IGNORE_FILENAMES.indexOf(filename.toLowerCase()) >= 0) {
    			sbCommonUtils.dbg("loadChildren: ignored filename, skipping");
    			continue; //skip our bookkeeping
    		}

    		if (aRes.indexOfFilename(filename) >= 0) {
    			sbCommonUtils.dbg("loadChildren: already loaded, skipping");
    			continue; //already positioned
    		}
    		sbCommonUtils.dbg("loadChildren: adding "+filename+" to "+aRes.filename);
    		aRes.insertChild(this._loadResource(entry, recursive));
    	}
    	aRes._loadingChildren = false;
    	sbCommonUtils.dbg("loadChildren("+fso.leafName+"): finished, "+aRes.children.length+" children");
    },
    
    //Loads a single Resource, determining its type
    _loadResource : function(fso, recursive) {
    	sbCommonUtils.dbg(fso);
    	var filename = fso.leafName;
    	sbCommonUtils.dbg("_loadResource: filename="+filename);
		if (fso.isDirectory()) {
			var aRes = new Resource(null, "folder", fso);
			if (recursive)
				this._loadChildren(aRes, fso, recursive);
			return aRes;
		} else
		switch (filename.split('.').pop()) {
			case "txt": {
				sbCommonUtils.dbg("_loadResource: fso.leafName = "+fso.leafName);
				return new Resource(null, "note", fso); break;
			}
			default: return new Resource(null, "", fso); break;
		}
    },
    
    
    //Takes a string describing a path to a resource, e.g.
    //  Folder 1/Folder 2/File.txt
    //  Folder 1:Folder 2:File.txt
    //Returns the resource object or nil.
    findResourceByPath : function(path) {
    	path = path.replace(/[\\\/]/g, '/').split(':');
    	var entry = this.root;
    	while (path.length != 0) {
    		var filename = path.shift();
    		if (filename == '') continue; //double slash, whatever
    		entry = entry.childByFilename(filename);
    		if (!entry) return null;
    	}
    	return entry;
    },
    
    //Takes a 14-digit rdfId and searches for a resource which matches it
    findResourceById : function(id) {
    	for (var i = 0; i < this.nodes.length; i++)
    		if (this.nodes[i].rdfId == id)
    			return this.nodes[i];
    	return null;
    },
    
    findResourceByUrn : function(urn) {
    	if (urn == "urn:scrapbook:root") {
    		sbCommonUtils.dbg("findResourceByUrn: returning root ("+this.root+")");
    		return this.root;
    	}
    	var pre = "urn:scrapbook:item";
    	if (urn.startsWith(pre))
    		return this.findResourceById(urn.slice(pre.length));
    	return null;
    },
    
    findResourceByRdfRes : function(res) {
    	for (var i = 0; i < this.nodes.length; i++)
    		if (this.nodes[i].rdfRes == res)
    			return this.nodes[i];
    	return null;
    },
    getResourceByRdfRes : function(res) {
    	var node = this.findResourceByRdfRes(res);
    	if (!node) throw "Cannot find resource by RDF res "+res;
    	return node;
    },
    

    // when data source change (mostly due to changing pref)
    checkRefresh : function(aNoCheck) {
        this._uninit();
        this._init();
        sbCommonUtils.refreshGlobal();
    },

    backup : function() { /* nothing to backup in this version */ },
    cleanUpBackups : function(bDir) { /* nothing to backup in this version */ },

    flush : function() {
        if (this._flushTimer) {
            this._flushTimer.cancel();
            this._flushTimer = null;
        }
        this._needReOutputTree = true;
        try {
            //TODO: flush... something? probably index.dat files, though they're per-resource
        } catch(ex) {
            sbCommonUtils.error(ex);
        }
    },

    _flushWithDelay : function() {
        if (this._flushTimer) return;
        this._needReOutputTree = true;
        this._flushTimer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
        // this.observe is called when time's up
        this._flushTimer.init(this, 10000, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
    },

    observe : function(aSubject, aTopic, aData) {
        switch (aTopic) {
            case "timer-callback": 
                this.flush();
                break;
            case "quit-application-requested": 
                this.outputTreeAuto();
                this._uninit();
                break;
            default: 
        }
    },

    unregister : function() {
        //TODO: remove if no one uses this?
    },



    sanitize : function(aVal) {
        if ( !aVal ) return "";
        return aVal.replace(/[\x00-\x1F\x7F]/g, " ");
    },

    validateURI : function(aURI) { return sbRDF.validateURI(aURI); },

    addItem : function(aSBitem, aParName, aIdx) {
        if ( !this.validateURI("urn:scrapbook:item" + aSBitem.id) ) return;
        ["title", "comment", "icon", "source"].forEach(function(prop) {
            aSBitem[prop] = this.sanitize(aSBitem[prop]);
        }, this);
        try {
        	sbCommonUtils.dbg("addItem: looking for parent: "+aParName);
            var parent = this.findResourceByUrn(aParName, false);
            if ( !parent ) {
            	sbCommonUtils.dbg("addItem: cannot find parent");
                parent = this.root;
                aIdx = 0;
            }
            sbCommonUtils.dbg("addItem: parent "+parent);
			
            //choose suitable and unique filename
            switch (aSBitem.type) {
            	case "folder": var ext = ""; break;
            	case "note": var ext = "txt"; break;
            	default: var ext = ""; break;
            }
            var title = (aSBitem.title != "") ? aSBitem.title : (aSBitem.type != "") ? aSBitem.type : "Resource";
            var filename = this.reserveFilename(parent, title, ext);
            sbCommonUtils.dbg("addItem: reserved filename: "+filename);
			
            //create a new resource
            var fso = parent.getFilesystemObject().clone();
            fso.append(filename);
            var newItem = new Resource(aSBitem.id, aSBitem.type, fso);
            if (filename != aSBitem.title)
            	newItem.setCustomTitle(aSBitem.title)
            
            //dump all properties for debug
            //TODO: Remove when I'm certain that I'm handling all the important properties
            for (prop in aSBitem)
                sbCommonUtils.dbg("addItem: "+prop+"="+aSBitem[prop]);

            //Insert to parent
            if ( sbCommonUtils.getPref("tree.unshift", false) ) {
                if ( aIdx == 0 || aIdx == -1 ) aIdx = 1;
            }
           	parent.insertChild(newItem, aIdx);
           	sbCommonUtils.dbg("addItem: child inserted");
            
            //Associate any filesystem objects and write to them
	        switch (newItem.type) {
	            case "folder": this.needFolderDir(newItem); break;
	            case "note": this._writeNoteContents(newItem, ""); break; //touch the file so the filename is not stolen
	        }

            this._flushWithDelay();
            return newItem;
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_ADD_RESOURCE", [ex]));
            return false;
        }
    },

    moveItem : function(curRes, curPar, tarPar, tarRelIdx) {
        try {
    		tarRelIdx -= 1; //RDF is indexed starting with 1
	    	curRes = this.getResourceByRdfRes(curRes);
	    	if (!curRes || !curRes.parent || (curRes.parent.rdfRes != curPar))
	    		throw "moveItem: invalid resource/parent combination"; //should not happen
	    	curPar = curRes.parent;
	    	tarPar = this.getResourceByRdfRes(tarPar);
	    	if (!tarPar || !tarPar.isContainer)
	    		throw "moveItem: target parent not found / not a container";
        	sbCommonUtils.dbg("moveItem("+curRes+","+curPar+","+tarPar+","+tarRelIdx+")");
	    	if (curRes.isFilesystemObject) {
	    		var resFSO = curRes.getFilesystemObject(); // we'll be unable to retrieve it later
        		sbCommonUtils.dbg("moveItem: FSO = "+resFSO.path);
	    	}
			curPar.removeChild(curRes);
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_ADD_RESOURCE1", [ex]));
            return;
        }

		sbCommonUtils.dbg("moveItem: detached from parent");

        if ( sbCommonUtils.getPref("tree.unshift", false) ) {
            if ( tarRelIdx == 0 || tarRelIdx == -1 ) tarRelIdx = 1;
        }

        try {
        	tarPar.insertChild(curRes, tarRelIdx);
            //Move the item on disk, choosing a new suitable name
            if (curRes.isFilesystemObject) {
            	sbCommonUtils.dbg("moveItem: moving filesystem object...");
            	this.moveFilesystemObject(curRes, resFSO);
            }
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_ADD_RESOURCE2", [ex]));
            this.curPar.insertChild(curRes);
        }
        sbCommonUtils.dbg("moveItem: done");
        this._flushWithDelay();
    },

    copyItem : function(curRes, tarPar, tarRelIdx) {
        var oldID = this.getProperty(curRes, "id");
        var newID = this.identify(oldID);
        // copy content
        var oldDir = sbCommonUtils.getContentDir(oldID);
        var newDir = sbCommonUtils.getContentDir(newID);
        oldDir.copyTo(newDir.parent, newID);
        // create new item
        var newItem = this.getItem(curRes);
        newItem.id = newID;
        sbCommonUtils.writeIndexDat(newItem);
        // add to resource
        if ( sbCommonUtils.getPref("tree.unshift", false) ) {
            if ( tarRelIdx == 0 || tarRelIdx == -1 ) tarRelIdx = 1;
        }
        var newRes = this.addItem(newItem, tarPar.Value, tarRelIdx);
        this._flushWithDelay();
    },

    createEmptySeq : function(aResName) {
        //TODO: Remove if there's no point in it.
    },

	//Deletes an item and all of its known children, including any associated folders or files on disk.
	//Does not delete resources not tracked by us.
    deleteItemDescending : function(aRes, aParRes, aRecObj) {
    	try {
	        var rmIDs = aRecObj || [];
	    	//Remove any children items
            if (this.isContainer(aRes)) {
	    		this.flattenResources(aRes, 0, false).forEach(function(aChildRes) {
	    			if (aChildRes != aRes)
	    				this.deleteItemDescending(aChildRes, aRes, rmIDs);
		    	}, this);
		    }
		    
	    	//Delete the item on disk
	    	if (this.isFilesystemObject(aRes)) {
	        	var resFSO = this.getAssociatedFsObject(aRes);
	        	sbCommonUtils.dbg("removeResource: considering "+resFSO.path+" for removal");
	        	if (resFSO.exists()) {
	        		sbCommonUtils.dbg("removeResource: removing "+resFSO.path);
	        		//If a folder: By this time all known children are removed. So if there are any unknowns, we can't delete the folder.
	        		resFSO.remove(false); //without children
	        	}
	    	}

			//Delete the item + properties from RDF
			if (aParRes) {
				sbCommonUtils.RDFC.Init(sbRDF._dataObj, aParRes);
				sbCommonUtils.RDFC.RemoveElement(aRes, true);
			}
			rmIDs.push(this.removeResource(aRes));
	        return rmIDs;
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_REMOVE_RESOURCE", [ex]));
            return false;
        }
    },

	//Removes a resource with all properties from RDF. Do not call directly, use deleteItemDescending for proper deletion (with recursion and resources)
    removeResource : function(aRes) {
    	//Remove all properties
        var names = sbRDF._dataObj.ArcLabelsOut(aRes);
        var rmID = this.getProperty(aRes, "id");
        sbCommonUtils.dbg("removeResource: removing "+rmID);
        while ( names.hasMoreElements() ) {
            try {
                var name  = names.getNext().QueryInterface(Components.interfaces.nsIRDFResource);
                var value = sbRDF._dataObj.GetTarget(aRes, name, true);
                sbRDF._dataObj.Unassert(aRes, name, value);
            } catch(ex) {
            	sbCommonUtils.log("removeResource: exception: "+ex);
            }
        }
        this._flushWithDelay();
        return rmID;
    },



    //Reads all of resources's data, except for internal bookkeeping
    getItem : function(aRes) {
        var ns = sbCommonUtils.namespace, nsl = ns.length;
        var item = sbCommonUtils.newItem();
        var names = sbRDF._dataObj.ArcLabelsOut(aRes);
        while ( names.hasMoreElements() ) {
            try {
                var name  = names.getNext().QueryInterface(Components.interfaces.nsIRDFResource);
                if (name.Value.substring(0, nsl) != ns) continue;
                var key = name.Value.substring(nsl);
                var value = sbRDF._dataObj.GetTarget(aRes, name, true).QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
                item[key] = value;
            } catch(ex) {
            	sbCommonUtils.log("getItem: exception: "+ex);
            }
        }
        return item;
    },

    getProperty : function(aRes, aProp) {
        if ( aRes.Value == "urn:scrapbook:root" ) return "";
        try {
            var retVal = sbRDF._dataObj.GetTarget(aRes, sbCommonUtils.RDF.GetResource(sbCommonUtils.namespace + aProp), true);
            return retVal.QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
        } catch(ex) {
            return "";
        }
    },
    
	//Sets properties of a resource available to external clients.
	//This triggers changes in actual data, if you only want to set properties of RDF, see sdRDF.
	setProperty : function(aRes, aProp, newVal) {
		aRes = this.getResourceByRdfRes(aRes);
		if (aRes.isRoot) return; //can't change anything for root
		newVal = this.sanitize(newVal);

		try {
			switch (aProp) {
			case "title":
				if (aRes.getTitle() == newVal) return;
				sbCommonUtils.dbg("Changing item title: "+aRes.getTitle()+" -> "+newVal);
				aRes.setCustomTitle(newVal);
				if (aRes.isFilesystemObject) {
					// We've set the title override, effectively forcing this title as "visible"
					// Now we'll ask associateFilename() to choose us something optimal and it'll remove the override if it can save the file under this title
					var oldFile = aRes.getFilesystemObject();
					this.moveFilesystemObject(aRes, oldFile); //basically we're asking it to reconsider the filename
				}
				break;
			case "icon": aRes.icon = newVal; break;
			case "source": aRes.source = newVal; break;
			case "comment": aRes.comment = newVal; break;
			case "lock": aRes.lock = (newVal.toLowerCase() == "true"); break;
			default:
				//Changing other properties is not supported at this time.
			}

            this._flushWithDelay();
        } catch(ex) {
            sbCommonUtils.error(ex);
        }
    },

    getURL : function(aRes) {
        var id = aRes.Value.substring(18);
        switch ( this.getProperty(aRes, "type") ) {
            case "folder"   : return "chrome://scrapbook/content/view.xul?id=" + id; break;
            case "note"     : return "chrome://scrapbook/content/note.xul?id=" + id; break;
            case "bookmark" : return this.getProperty(aRes, "source"); break;
            default         : return sbCommonUtils.getBaseHref(sbRDF._dataObj.URI) + "data/" + id + "/index.html";
        }
    },

    exists : function(aRes) {
        if ( typeof(aRes) == "string" ) {
            aRes = sbCommonUtils.RDF.GetResource("urn:scrapbook:item" + aRes);
        }
        return sbRDF._dataObj.ArcLabelsOut(aRes).hasMoreElements();
    },

    isolated : function(aRes) {
        return !sbRDF._dataObj.ArcLabelsIn(aRes).hasMoreElements();
    },

    isContainer : function(aRes) {
        return sbCommonUtils.RDFCU.IsContainer(sbRDF._dataObj, aRes);
    },
	
	//True if the resource represents a filesystem object (as opposed to purely virtual resources such as separators)
	isFilesystemObject : function(aRes) {
	    var resType = this.getProperty(aRes, "type");
	    return ((resType == "folder") || (resType == "note"));
	},

	// Ensures that a given item ID is unused (altering it if needed)
    identify : function(aID) {
        while ( this.exists(aID) ) {
            aID = (parseInt(aID, 10) + 1).toString();
        }
        return aID;
    },

    getRelativeIndex : function(aParRes, aRes) {
        return sbCommonUtils.RDFCU.indexOf(sbRDF._dataObj, aParRes, aRes);
    },

    // aRule: 0 for any, 1 for containers (folders), 2 for items
    flattenResources : function(aContRes, aRule, aRecursive, aRecObj) {
        var resList = aRecObj || [];
        if ( aRule != 2 ) resList.push(aContRes);
        sbCommonUtils.RDFC.Init(sbRDF._dataObj, aContRes);
        var resEnum = sbCommonUtils.RDFC.GetElements();
        while ( resEnum.hasMoreElements() ) {
            var res = resEnum.getNext().QueryInterface(Components.interfaces.nsIRDFResource);
            if ( this.isContainer(res) ) {
                if ( aRecursive ) {
                    this.flattenResources(res, aRule, aRecursive, resList);
                } else {
                    if ( aRule != 2 ) resList.push(res);
                }
            } else {
                if ( aRule != 1 ) resList.push(res);
            }
        }
        return resList;
    },

    findParentResource : function(aRes) {
        var resEnum = sbRDF._dataObj.GetAllResources();
        while ( resEnum.hasMoreElements() ) {
            var res = resEnum.getNext().QueryInterface(Components.interfaces.nsIRDFResource);
            if ( !this.isContainer(res) ) continue;
            if ( res.Value == "urn:scrapbook:search" ) continue;
            if ( sbCommonUtils.RDFCU.indexOf(sbRDF._dataObj, res, aRes) != -1 ) return res;
        }
        return null;
    },

    getFolderPath : function(aRes) {
        var ret = [];
        while (true) {
            aRes = this.findParentResource(aRes);
            if ( !aRes || aRes.Value == "urn:scrapbook:root" ) break;
            ret.unshift(this.getProperty(aRes, "title"));
        }
        return ret;
    },
    
    
    
    //Replaces all characters that the file system might not support with safe characters.
    sanitizeFilename : function(filename) {
    	if (!filename) return "";
        return filename.replace(/[\x00-\x1F\x7F\<\>\:\"\/\\\|\?\*\=]/g, " ");
    },
    
    //Selects a non-existent filename based on a given pattern. Returns the name as string.
    //If existingName is given, it is assumed to be ours (so when stumbling upon it, we'll not consider it taken)
    selectUniqueFilename : function(parentDir, filename, ext, existingName) {
    	var finalName;
		if (ext != '')
			finalName = filename + "." + ext
		else
			finalName = filename;

		var index = 1;
    	while (true) {
    		if (finalName == existingName) return existingName;
			var finalPath = parentDir.clone();
			finalPath.append(finalName);
			if (!finalPath.exists()) return finalName;
    		
			if (ext != '')
				finalName = filename + "(" + index + ")"  + "." + ext
			else
				finalName = filename + "(" + index + ")";
			index++;
    	}
    },
    
    //Chooses a suitable and unused filename for a resource based on it's title. Returns the filename.
    //This function does NOT claim the name, so if you don't hurry, someone else might take it.
	//If existingName is given, it is assumed to be ours (we'll not consider it taken if we stumble upon it)
    reserveFilename : function(aParent, aTitle, aExt, aExistingName) {
    	sbCommonUtils.dbg("reserveFilename("+aParent+','+aTitle+','+aExt+','+aExistingName+')');
    	var parentDir = aParent.getFilesystemObject();
    	var filename = this.selectUniqueFilename(parentDir, this.sanitizeFilename(aTitle), aExt, aExistingName);
		sbCommonUtils.dbg("reserveFilename: "+filename);
		return filename;
    },

	//Same, but takes a Resource and also updates the title override if needed.
	//Basically does whatever is neccessary to keep the visible title the same.
    associateFilename : function(aRes, existingName) {
       	switch(aRes.type) {
    		case "folder": var ext = ""; break;
    		case "note": var ext = "txt"; break;
    		case "bookmark": var ext = "url"; break;
    		default: var ext = ""; break;
    			//throw "reserveFilename: unsupported resource type: "+resType;
    	}

    	//Get the actual visible title. Whatever low-level name we choose, we have to keep this as our visible name.
    	var title = aRes.getTitle();
    	//If the title is empty, let's suggest something for the filename anyway
    	var fnSuggestion = (title != "") ? title : (aRes.type != "") ? aRes.type : "Resource";

    	if (!aRes.parent)
    		throw "associateFilename: resource must be attached to a parent";
    	aRes.filename = this.reserveFilename(aRes.parent, fnSuggestion, ext, existingName);
    	if (aRes.filename != ((ext != '') ? title + '.' + ext : title))
    		//Chosen name was different from the title. We need to store the title as an additional attribute.
    		aRes.setCustomTitle(title)
    	else
    		aRes.setCustomTitle(null); //the filename suffices
    	sbCommonUtils.log("associateFilename: new filename: "+aRes.filename+', title override: '+aRes._title);
    	return aRes.filename;
    },
    

    //Ensures a directory exists for a folder resource and returns a directory object.
    //If the directory does not exist, it is automatically created, but no other initialization will take place. This may restore
    //a folder that was accidentally deleted manually, but will not properly choose and register a name substitution anew.
    needFolderDir : function(aFolder) {
    	if (!aFolder.isFolder) throw "needFolderDir: not a folder but "+aFolder.type;
    	var path = aFolder.getFilesystemObject();
    	sbCommonUtils.dbg("needFolderDir("+path.path+")");
    	if ( !path.exists() ) path.create(path.DIRECTORY_TYPE, 0700);
    	return path;
    },

	//Chooses a new suitable filename for a resource under a new parent, and moves the data.
	//Old file/dir must be given explicitly, that's where the resource is.
	moveFilesystemObject : function(aRes, oldFile) {
    	sbCommonUtils.dbg("moveFilesystemObject: moving "+oldFile.path);
    	var targetDir = this.needFolderDir(aRes.parent);

    	//If we're moving to the same folder, give associateFilename() old name --
    	//or it will consider it taken and give us another one
    	if (oldFile.parent.equals(targetDir))
    		var oldName = oldFile.leafName
    	else
    		var oldName = null;

		//We need to choose a target name even if there's no data to move,
		//or we risk stealing already existing item.
		var targetName = this.associateFilename(aRes, oldName); //choose a new suitable name at a target place
		sbCommonUtils.dbg("moveFilesystemObject: new target name: "+targetName);

		if (oldFile.exists()) {
			sbCommonUtils.dbg("moveFilesystemObject: object exist, moving: "+oldFile.path);
			oldFile.moveTo(targetDir, targetName);
		} else {
			sbCommonUtils.dbg("moveFilesystemObject: old object does not exist, skipping: "+oldFile.path);
		}
	},
	
	
	
	/*
	Note editing.
	Perhaps this should be moved to scrapnote.js, and datasource only host generic functions.
	But then what do we do about folders? There's no one governing those.
	*/
	
	//Reads the contents of the note and returns it
	readNoteContents : function(aNoteRdfRes) {
		try {
			return this._readNoteContents(this.getResourceByRdfRes(aNoteRdfRes));
		} catch(ex) {
			sbCommonUtils.alert("Failed to read note. Abort operation or your data may be lost."); //TODO: Localize
			throw ex;
		}
	},
	//Same but accepts a Resource()
	_readNoteContents : function(aNote) {
		sbCommonUtils.dbg("Reading note contents: "+aNote.filename);
       	var content = sbCommonUtils.readFile(aNote.getFilesystemObject());
		return sbCommonUtils.convertToUnicode(content, "UTF-8");
	},
	
	//Outputs note contents to the associated file. Returns false if failed.
	writeNoteContents : function(aNoteRdfRes, content) {
		try {
			return this._writeNoteContents(this.getResourceByRdfRes(aNoteRdfRes), content);
		} catch(ex) {
			sbCommonUtils.alert("Failed to save note. Backup the data before continuing, or it may be lost."); //TODO: Localize
			return false;
		}
	},
	_writeNoteContents : function(aNote, content) {
		sbCommonUtils.dbg("Writing note contents: "+aNote.filename);
		var file = aNote.getFilesystemObject();
		sbCommonUtils.writeFile(file, content.replace(/[\r\n]/g,'\n').replace(/\r|\n/g,'\r\n'), "UTF-8");
		return true;
	},
	
	
    outputTreeAuto : function(aWindow) {
        if (!sbCommonUtils.getPref("autoOutput", false)) return;
        if (!this._needReOutputTree) return;
        try {
            if (!aWindow) aWindow = sbCommonUtils.getFocusedWindow();
            aWindow.openDialog('chrome://scrapbook/content/output.xul','ScrapBook:Output','chrome,modal', true);
        } catch(ex) {
        }
    },

    outputTreeAutoDone : function() {
        this._needReOutputTree = false;
    }
};

var EXPORTED_SYMBOLS = ["sbDataSource"];