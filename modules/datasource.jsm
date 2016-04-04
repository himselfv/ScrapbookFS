Components.utils.import("resource://scrapbook-modules/common.jsm");
Components.utils.import("resource://scrapbook-modules/fakerdf.jsm");


/*
  Creates a basic resource. Additional properties may be added by the caller.

  Each resource has an unique RDF URI:
    urn:scrapbook:root
    urn:scrapbook:item12345678901234
  These 14 digits are called rdfId. In our implementation, they are mostly random and only valid
  for this session.
  Resources that are loaded from FS get a random ID. When resources are added from UI, UI generates
  the ID and we just accept it.
  
  You must pass the ID now, or we'll select it automatically.
  
  Valid constructors:
    Resource(null, "root"); //use urn:scrapbook:root
    Resource(null, "folder", filename); //auto-generate
    Resource("urn:scrapbook:item12345678901234", ...); //use explicit
*/
function Resource(rdfId, type, filename) {
	sbCommonUtils.dbg('Resource('+rdfId+','+type+','+filename+')');
	this.rdfId = rdfId;
	this.type = type;
	this.filename = filename;
	this.registerRdf();
	sbDataSource.nodes.push(this); //auto-register us in a node list
}

Resource.prototype = {
	parent : null,
	type : "", //root, folder, note, ...
	filename : "",

	_FSO : null, //explicit filesystem object, only set for root node
	getFilesystemObject : function() {
		if (this._FSO)
			return this._FSO //set for root
		else {
			var FSO = this.parent.getFilesystemObject().clone();
			FSO.append(this.filename);
			return FSO;
		}
	},


	_title : null, //explicit title, if overriden

	getTitle : function() {
		sbCommonUtils.dbg("getTitle()");
		//If we have overriden title, use that
		if (this._title) {
			sbCommonUtils.dbg("returning "+this._title);
			return this._title;
		}

		//Strip extension
		var parts = this.filename.split('.');
		if (parts.pop().length > 5) {
			sbCommonUtils.dbg("returning "+this.filename);
			return this.filename //probably wasn't an extension
		}
		else {
			sbCommonUtils.dbg("returning "+parts.join('.'));
			return parts.join('.');
		}
	},
	
	//Sets title override. If this is empty, filename is used as title.
	//Use when the filename which you assign in create/rename/move cannot be represented by FS or conflicts with existing one.
	setCustomTitle : function(aTitle) {
		sbCommonUtils.dbg("setCustomTitle: '"+aTitle+"'");
		this._title = aTitle;
		sbRDF.setProperty(this.rdfRes, 'title', this.getTitle()); //update RDF
	},


	// Index.dat
	_index : null, //explicit index, if present
	
	//Loads index.dat for the directory into ordered {id,title} pairs
	_loadIndexDat : function (fso) {
		sbCommonUtils.dbg("loadIndexDat: "+fso.path);
		var index = fso.clone();
		index.append("index.dat");
		if (!index.exists())
			return [];
		
		var entries = [];
		var lines = sbCommonUtils.readFile(index).replace(/\r\n|\r/g, '\n').split("\n");
		lines.forEach(function(line) {
			if (line == "") return; //safety
			var parts = line.split('=');
			entries.append({
			  id: parts.shift(),
			  title: parts.join("=")
			});
		});
		return entries;
	},
	loadIndex : function (fso) {
		this._index = this._loadIndexDat(fso);
	},


	// Children 
	children : [],

	//Returns the index of the entry with this filename in children
	indexOfFilename : function(filename) {
		for (var i = 0; i < this.children.length; i++)
			if (this.children[i].filename == filename)
				return i;
		return -1;
	},
	
	indexOfChild : function(child) {
		for (var i = 0; i < this.children.length; i++)
			if (this.children[i] == child)
				return i;
		return -1;
	},
	
	childByFilename : function(filename) {
		var i = this.indexOfFilename();
		if (i >= 0)
			return this.children[i]
		else
			return null;
	},
	
	insertChild : function(child, index) {
		var cont = this.rdfCont();
		if ( 0 < index && index <= this.children.length ) {
			this.children.splice(index, 0, child);
			cont.InsertElementAt(child.rdfRes, index, true);
		} else {
			this.children.push(child);
			cont.AppendElement(child.rdfRes);
		}
		child.parent = this;
	},
	
	removeChild : function(child) {
		var index = this.indexOfChild(child);
		if (index < 0) throw "removeChild: Child not found";
		return this.removeChildByIndex(index);
	},
	removeChildByIndex : function(index) {
		var cont = this.rdfCont();
		var child = this.children.splice(index, 1);
		cont.RemoveElement(child.rdfRes, true); //safer to remove by resource than by index
		child.parent = null;
		return child;
	},

	moveChild : function(child, newIndex) {
		var index = this.indexOfChild(child);
		this.moveChildByIndex(index, newIndex);
	},
	moveChildByIndex : function(oldIndex, newIndex) {
		var child = this.removeChildByIndex(oldIndex);
		if (oldIndex < newIndex) newIndex = newIndex - 1; //shifted due to removal
		this.insertChild(newIndex, child);
	},


	// RDF
	rdfId : null, //must be 14 digits for any node except for root
	rdfRes : null, //RDF resource associated with this FS object. Does not change through the lifetime of resource.

    getRdfName : function() {
    	if (this.type == "root")
    		return "urn:scrapbook:root"
    	else
    		return "urn:scrapbook:item" + this.rdfId;
    },

	//Performs initial registration of the resource in the RDF store
	registerRdf : function() {
		if ((this.type != "root") && (!this.rdfId))
			this.rdfId = sbRDF.newId(); //auto-create ID
		if (!this.rdfRes)
			this.rdfRes = sbCommonUtils.RDF.GetResource(this.getRdfName());
		sbCommonUtils.dbg("registerRdf: id="+this.rdfId);
		this.updateRdfProps(); //push properties

		//Folders need attached sequence or they won't be displayed as folders
		if (this.type == "folder")
			sbRDF.createEmptySeq(this.getRdfName());

		//Separators additionally need this to be visible in the tree
		if (this.type == "separator") {
	        sbRDF._dataObj.Assert(
	            this.rdfRes,
	            sbCommonUtils.RDF.GetResource("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
	            sbCommonUtils.RDF.GetResource("http://home.netscape.com/NC-rdf#BookmarkSeparator"),
	            true
	        );
		}
	},

	updateRdfProps : function() {
		if (this.type == "root") return; //root never has attributes
		/*
		Standard RDF properties:
	           NS1:id="20160403063754"
	           NS1:create="20160403063754"
	           NS1:modify="20160403063754"
	           NS1:type="note"
	           NS1:title=""
	           NS1:chars="UTF-8"
	           NS1:icon=""
	           NS1:source=""
	           NS1:comment=""
	           NS1:lock=""
		*/
		sbRDF.setProperty(this.rdfRes, 'id', this.rdfId);
		sbRDF.setProperty(this.rdfRes, 'create', ""); //TODO
		sbRDF.setProperty(this.rdfRes, 'modify', ""); //TODO
		sbRDF.setProperty(this.rdfRes, 'type', this.type);
		sbRDF.setProperty(this.rdfRes, 'title', this.getTitle()); //TODO
		sbRDF.setProperty(this.rdfRes, 'chars', "UTF-8"); //TODO
		sbRDF.setProperty(this.rdfRes, 'icon', ""); //TODO
		sbRDF.setProperty(this.rdfRes, 'source', ""); //TODO
		sbRDF.setProperty(this.rdfRes, 'comment', ""); //TODO
		sbRDF.setProperty(this.rdfRes, 'lock', ""); //TODO
		//These need to be updated every time they're changed for this object.
		//This may be done automatically if we write wrappers for all these properties, or manually by the caller (usually sbDataSource's setProperty, so its okay too)
	},
	
	//RDF container associated with this container object
	_rdfCont : null,
	rdfCont : function() {
		if (!this._rdfCont) {
			sbCommonUtils.dbg("creating rdfCont");
			var rdfName = this.getRdfName();
			sbCommonUtils.dbg("rdfName: "+rdfName);
			sbRDF.createEmptySeq(rdfName);
			this._rdfCont = sbRDF.getContainer(rdfName, false);
			sbCommonUtils.dbg("rdfCont: "+this._rdfCont);
		}
		return this._rdfCont;
	},
}


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
            this.root = new Resource(null, "root", "");
            this.root._FSO = sbCommonUtils.getScrapBookDir();
            sbCommonUtils.dbg('init: building file tree');
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




	//Checks the filesystem and loads all the children elements
	//At this time it can only be used for initial loading, but our final objective is to support reloading:
	//  we'll try to preserve any existing elements, instead reordering them.
    _loadChildren : function(aRes, fso, recursive) {
    	sbCommonUtils.dbg('loadChildren('+fso.path+'): hi children');
    	if (!fso.exists()) return;
    	if (!fso.isDirectory()) return;

		//Load index.dat
		sbCommonUtils.dbg('loadChildren('+fso.path+'): loading index.dat entries');
		aRes.loadIndex(fso);
		aRes._index.forEach(function(entry) {
			if (entry.id == "") return; //safety
			if (entry.id.startsWith('*')) {
				aRes.insertChild(new Resource(null, "separator"));
				return;
			}
			if (aRes.indexOfFilename(entry.id) >= 0) return; //don't list one resource twice //TODO: perhaps call refresh on child anyway, if recursive?

			var childFso = fso.clone();
			childFso.append(entries.id);
			var childRes = this._loadResource(childFso, recursive);
			if (entry.title != "")
				childRes.setCustomTitle(entry.title);
			aRes.insertChild(childRes);
		});
		
    	//Now load the rest of the directory entries
    	sbCommonUtils.dbg('loadChildren('+fso.path+'): loading the rest of the entries');
    	var entries = fso.directoryEntries;
    	while (entries.hasMoreElements()) {
    		var entry = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
    		var filename = entry.leafName;
    		if (aRes.indexOfFilename(filename) >= 0) continue; //already positioned
    		aRes.insertChild(this._loadResource(entry, recursive));
    	}
    },
    
    //Loads a single Resource, determining its type
    _loadResource : function(fso, recursive) {
    	sbCommonUtils.dbg(fso);
    	var filename = fso.leafName;
		if (fso.isDirectory()) {
			var aRes = new Resource(null, "folder", filename);
			if (recursive)
				this._loadChildren(aRes, fso, recursive);
			return aRes;
		} else
		switch (filename.split('.').pop()) {
			case "txt": return new Resource(null, "note", filename); break;
			default: return new Resource(null, "", filename); break;
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
    	for (var i = 0; i < nodes.length; i++)
    		if (nodes[i].rdfId == id)
    			return nodes[i];
    	return null;
    },
    
    findResourceByUrn : function(urn) {
    	if (urn == "urn:scrapbook:root") {
    		sbCommonUtils.dbg("findResourceByUrn: returning root ("+this.root+")");
    		return this.root;
    	}
    	var pre = "urn:scrapbook:item";
    	if (urn.startsWith(pre))
    		return findResourceById(urn.slice(pre.length));
    	return null;
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
            	case "folder": var ext = "";
            	case "note": var ext = "txt";
            	default: var ext = "";
            }
            var title = (aSBitem.title != "") ? aSBitem.title : (aSBitem.type != "") ? aSBitem.type : "Resource";
            var filename = this.reserveFilename(parent, title, ext);
            sbCommonUtils.dbg("addItem: reserved filename: "+filename);
			
            //create a new resource
            var newItem = new Resource(aSBitem.id, aSBitem.type, filename);
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
	            case "note": this.writeNoteContents(newItem, ""); break; //touch the file so the filename is not stolen
	        }

            this._flushWithDelay();
            return newItem;
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_ADD_RESOURCE", [ex]));
            return false;
        }
    },

    moveItem : function(curRes, curPar, tarPar, tarRelIdx) {
    	var resType = "";
    	var resFSO = null;
        try {
			if (this.isFilesystemObject(curRes))
				resFSO = this.getAssociatedFsObject(curRes); // we'll be unable to retrieve it later
			sbCommonUtils.RDFC.Init(sbRDF._dataObj, curPar);
			sbCommonUtils.RDFC.RemoveElement(curRes, true);
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_ADD_RESOURCE1", [ex]));
            return;
        }
        if ( sbCommonUtils.getPref("tree.unshift", false) ) {
            if ( tarRelIdx == 0 || tarRelIdx == -1 ) tarRelIdx = 1;
        }
        try {
            sbCommonUtils.RDFC.Init(sbRDF._dataObj, tarPar);
            if ( tarRelIdx > 0 ) {
                sbCommonUtils.RDFC.InsertElementAt(curRes, tarRelIdx, true);
            } else {
                sbCommonUtils.RDFC.AppendElement(curRes);
            }
            
            //Move the item on disk, choosing a new suitable name
            if (this.isFilesystemObject(curRes))
            	this.moveFilesystemObject(curRes, resFSO, tarPar);
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_ADD_RESOURCE2", [ex]));
            sbCommonUtils.RDFC.Init(sbRDF._dataObj, sbCommonUtils.RDF.GetResource("urn:scrapbook:root"));
            sbCommonUtils.RDFC.AppendElement(curRes, true);
        }
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



    //When reading and writing items, we mostly just copy all the available properties.
    //Some properties are internal though and should be hidden from clients (or they may write their obsolete values back later).
    internalPropertyNames : ["filename"],

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
                if (this.internalPropertyNames.indexOf(key) >= 0)
                    continue; //internal properties should be skipped
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
    
    //Updates all of resource's data
    saveItem : function(aRes, item) {
        for (var prop in item)
            sbDataSource.setProperty(aRes, prop, item[prop]);
    },
    
	//Sets properties of a resource available to external clients
	setProperty : function(aRes, aProp, newVal) {
		if (this.internalPropertyNames.indexOf(aProp) >= 0)
			return; //internal properties cannot be written
		return this.setInternalProperty(aRes, aProp, newVal);
	},

    //Sets any property of a resource, including internal ones
    setInternalProperty : function(aRes, aProp, newVal) {
        newVal = this.sanitize(newVal);
        var aPropName = aProp;
        aProp = sbCommonUtils.RDF.GetResource(sbCommonUtils.namespace + aPropName);
        try {
        	if ((aPropName == "title") && this.isFilesystemObject(aRes))
        		var oldFilename = this.getAssociatedFilename(aRes); //we won't be able to retrieve it later
        	
            var oldVal = sbRDF._dataObj.GetTarget(aRes, aProp, true);
            if (oldVal == sbCommonUtils.RDF.NS_RDF_NO_VALUE) {
                sbRDF._dataObj.Assert(aRes, aProp, sbCommonUtils.RDF.GetLiteral(newVal), true);
            } else {
                oldVal = oldVal.QueryInterface(Components.interfaces.nsIRDFLiteral);
                newVal = sbCommonUtils.RDF.GetLiteral(newVal);
                sbRDF._dataObj.Change(aRes, aProp, oldVal, newVal);
            }

            //When changing the title, rename the item on disk
            if ((aPropName == "title") && (oldVal != newVal) && this.isFilesystemObject(aRes)) {
            	sbCommonUtils.dbg("Changing item title: "+oldVal.Value+" -> "+newVal.Value);
            	var aParent = this.findParentResource(aRes);
            	var oldFile = this.getAssociatedFsObject(aParent).clone();
            	oldFile.append(oldFilename);
            	this.moveFilesystemObject(aRes, oldFile, aParent); //to the same folder
            }
            
            this._flushWithDelay();
        } catch(ex) {
            sbCommonUtils.error(ex);
        }
    },
    
    clearProperty : function(aRes, aProp) {
    	sbCommonUtils.log("clearProperty: "+aProp);
    	aProp = sbCommonUtils.RDF.GetResource(sbCommonUtils.namespace + aProp);
    	try {
    		var oldVal = sbRDF._dataObj.GetTarget(aRes, aProp, true);
            if (oldVal != sbCommonUtils.RDF.NS_RDF_NO_VALUE)
				sbRDF._dataObj.Unassert(aRes, aProp, oldVal);
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
	    resType = this.getProperty(aRes, "type");
	    return ((resType == "folder") || (resType == "note"));
	},

	//True if the resource is logically a folder (not just by the virtue of having RDF children, though in practice these should match).
	isFolder : function(aRes) {
    	return (aRes.type == "folder") || (aRes.rdfId == "urn:scrapbook:root");
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
    	var parentDir = aParent.getFilesystemObject();
    	sbCommonUtils.dbg("reserveFilename: parent directory: "+parentDir.path);
    	var filename = this.selectUniqueFilename(parentDir, this.sanitizeFilename(aTitle), aExt, aExistingName);
		sbCommonUtils.dbg("reserveFilename: "+filename);
		return filename;
    },

	//Same, but takes a resource and also registers the filename override in it. Deprecated.
    associateFilename : function(aRes, existingName) {
       	switch(aRes.type) {
    		case "folder": var ext = ""; break;
    		case "note": var ext = "txt"; break;
    		case "bookmark": var ext = "url"; break;
    		default: var ext = ""; break;
    			//throw "reserveFilename: unsupported resource type: "+resType;
    	}
    	
    	var title = this.getProperty(aRes, "title");
    	if (title == "") {
    		title = resType; //if title is empty, use "Note.txt"
    		if (title == "") //just in case
    			title = "Resource";
    	}
    	
		var aParent = this.findParentResource(aRes);
    	if (!aParent) throw "associateFilename: resource must be attached to a parent";
    	
    	var filename = this.reserveFilename(aParent, title, ext);
    	if (filename != title)
    		//Chosen name was different from the title. We need to store it as an additional attribute.
    		this.setInternalProperty(aRes, "filename", filename)
    	else
    		this.clearProperty(aRes, "filename"); //if any was set
    	sbCommonUtils.log("associateFilename: new override state: "+this.getProperty(aRes, "filename"));
    	return filename;
    },
    
    //Returns a filename associated to a resource, without any path. Does not choose a suitable one, just tells how it's configured now.
    //The resource is assumed to be initialized (associateFilename() called at least once).
    getAssociatedFilename : function(aRes) {
    	var filename = this.getProperty(aRes, "filename");
		if (filename == "")
			filename = this.getProperty(aRes, "title");
		return filename;
    },
    
    //Retrieves a file/directory associated with a specified resource (as an object), whether it exists or not.
    getAssociatedFsObject : function(aRes) {
    	if (!aRes)
    		throw "getAssociatedFsObject: invalid null resource received";
    	if (aRes.Value == "urn:scrapbook:root")
    		return sbCommonUtils.getScrapBookDir().clone();
    	
    	var resType = this.getProperty(aRes, "type");
        switch (resType) {
            case "folder":
            case "note":
            	var aParent = this.findParentResource(aRes);
            	if (!aParent) throw "getAssociatedFsObject: resource is not attached to a parent";
            	var path = this.needFolderDir(aParent);
            	path.append(this.getAssociatedFilename(aRes));
            	break;
            default:
            	throw "getAssociatedFsObject: unsupported resource type: "+resType;
        }
		
		return path;
    },
    
    //Ensures a directory exists for a folder resource and returns a directory object.
    //If the directory does not exist, it is automatically created, but no other initialization will take place. This may restore
    //a folder that was accidentally deleted manually, but will not properly choose and register a name substitution anew.
    needFolderDir : function(aFolder) {
    	if (!this.isFolder(aFolder)) throw "needFolderDir: not a folder but "+this.getProperty(folderRes, "type");
    	sbCommonUtils.dbg("needFolderDir: "+aFolder);
    	var path = aFolder.getFilesystemObject();
    	sbCommonUtils.dbg("needFolderDir: path="+path.path);
    	if ( !path.exists() ) path.create(path.DIRECTORY_TYPE, 0700);
    	return path;
    },

	//Chooses a new suitable filename for a resource under a new parent, and moves the data.
	//Old file/dir and new parent must be given explicitly since this is often called when moving stuff and the internal bookkeeping may be in tatters.
	//It is okay for the old path to point to non-existing file/dir.
	moveFilesystemObject : function(aRes, oldFile, newPar) {
    	sbCommonUtils.dbg("moveFilesystemObject: moving "+oldFile.path);
    	var targetDir = this.needFolderDir(newPar);

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
		
		sbCommonUtils.log("moveFilesystemObject: override state: "+this.getProperty(aRes, "filename"));
		sbCommonUtils.log("moveFilesystemObject: associated name: "+this.getAssociatedFilename(aRes));

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
	readNoteContents : function(aNoteRes) {
		try {
			var file = this.getAssociatedFsObject(aNoteRes);
        	var content = sbCommonUtils.readFile(file);
			return sbCommonUtils.convertToUnicode(content, "UTF-8");
		} catch(ex) {
			sbCommonUtils.alert("Failed to read note. Abort operation or your data may be lost."); //TODO: Localize
			throw ex;
		}
	},
	
	//Outputs note contents to the associated file. Returns false if failed.
	writeNoteContents : function(aNoteRes, content) {
		try {
			var file = this.getAssociatedFsObject(aNoteRes);
			sbCommonUtils.writeFile(file, content.replace(/[\r\n]/g,'\n').replace(/\r|\n/g,'\r\n'), "UTF-8");
			return true;
		} catch(ex) {
			sbCommonUtils.alert("Failed to save note. Backup the data before continuing, or it may be lost."); //TODO: Localize
			return false;
		}
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