Components.utils.import("resource://scrapbook-modules/common.jsm");

var sbDataSource = {

    _firstInit : true,
    _flushTimer : null,
    _dataObj : null,
    _dataFile : null,
    _needReOutputTree : false,

    get data() {
        if (!this._dataObj) this._init();
        return this._dataObj;
    },

    _init : function(aQuietWarning) {
        if (this._firstInit) {
            this._firstInit = false;
            var obs = Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService);
            obs.addObserver(this, "quit-application-requested", false);
        }
        try {
            this._dataFile = sbCommonUtils.getScrapBookDir();
            this._dataFile.append("scrapbook.rdf");
            if ( !this._dataFile.exists() ) {
                var iDS = Components.classes["@mozilla.org/rdf/datasource;1?name=xml-datasource"].createInstance(Components.interfaces.nsIRDFDataSource);
                sbCommonUtils.RDFCU.MakeSeq(iDS, sbCommonUtils.RDF.GetResource("urn:scrapbook:root"));
                var iFileUrl = Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService).newFileURI(this._dataFile);
                iDS.QueryInterface(Components.interfaces.nsIRDFRemoteDataSource).FlushTo(iFileUrl.spec);
            }
            var fileURL = sbCommonUtils.IO.newFileURI(this._dataFile).spec;
            this._dataObj = sbCommonUtils.RDF.GetDataSourceBlocking(fileURL);
            this._needReOutputTree = false;
        } catch(ex) {
            if ( !aQuietWarning ) sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_INIT_DATASOURCE", [ex]));
        }
    },

    _uninit : function() {
        if (this._flushTimer) this.flush();
        try { sbCommonUtils.RDF.UnregisterDataSource(this._dataObj); } catch(ex) {}
        this._dataObj = null;
        this._dataFile = null;
    },

    // when data source change (mostly due to changing pref)
    checkRefresh : function(aNoCheck) {
        this._uninit();
        this._init();
        sbCommonUtils.refreshGlobal();
    },

    backup : function() {
        var bDir = sbCommonUtils.getScrapBookDir();
        bDir.append("backup");
        if ( !bDir.exists() ) bDir.create(bDir.DIRECTORY_TYPE, 0700);
        var bFileName = "scrapbook_" + sbCommonUtils.getTimeStamp().substring(0,8) + ".rdf";
        try { this._dataFile.copyTo(bDir, bFileName); } catch(ex) {}
        this.cleanUpBackups(bDir);
    },

    cleanUpBackups : function(bDir) {
        var max = 5;
        var today = (new Date()).getTime();
        var dirEnum = bDir.directoryEntries;
        while ( dirEnum.hasMoreElements() ) {
            var entry = dirEnum.getNext().QueryInterface(Components.interfaces.nsILocalFile);
            if ( !entry.leafName.match(/^scrapbook_(\d{4})(\d{2})(\d{2})\.rdf$/) ) continue;
            var lifeTime = (new Date(parseInt(RegExp.$1, 10), parseInt(RegExp.$2, 10) - 1, parseInt(RegExp.$3, 10))).getTime();
            lifeTime = Math.round((today - lifeTime) / (1000 * 60 * 60 * 24));
            if ( lifeTime > 30 ) {
                if (--max < 0) break;
                entry.remove(false);
            }
        }
    },

    flush : function() {
        if (this._flushTimer) {
            this._flushTimer.cancel();
            this._flushTimer = null;
        }
        this._needReOutputTree = true;
        try {
            this._dataObj.QueryInterface(Components.interfaces.nsIRDFRemoteDataSource).Flush();
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
        sbCommonUtils.RDF.UnregisterDataSource(this._dataObj);
    },



    sanitize : function(aVal) {
        if ( !aVal ) return "";
        return aVal.replace(/[\x00-\x1F\x7F]/g, " ");
    },

    validateURI : function(aURI) {
        if ( aURI == "urn:scrapbook:root" || aURI == "urn:scrapbook:search" || aURI.match(/^urn:scrapbook:item\d{14}$/) ) {
            return true;
        } else {
            return false;
        }
    },

    addItem : function(aSBitem, aParName, aIdx) {
        if ( !this.validateURI("urn:scrapbook:item" + aSBitem.id) ) return;
        ["title", "comment", "icon", "source"].forEach(function(prop) {
            aSBitem[prop] = this.sanitize(aSBitem[prop]);
        }, this);
        try {
            var cont = this.getContainer(aParName, false);
            if ( !cont ) {
                cont = this.getContainer("urn:scrapbook:root", false);
                aIdx = 0;
            }
            // create a new item and merge the props
            var newItem = sbCommonUtils.newItem();
            sbCommonUtils.extendObject(newItem, aSBitem);
            var newRes = sbCommonUtils.RDF.GetResource("urn:scrapbook:item" + aSBitem.id);
            for (prop in newItem) {
                if (prop == "folder") continue;  // "folder" prop is specially handled and do not need to store
                var arc = sbCommonUtils.RDF.GetResource(sbCommonUtils.namespace + prop);
                var val = sbCommonUtils.RDF.GetLiteral(aSBitem[prop]);
                this._dataObj.Assert(newRes, arc, val, true);
            }
            if (aSBitem.type == "separator") {
                this._dataObj.Assert(
                    newRes,
                    sbCommonUtils.RDF.GetResource("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
                    sbCommonUtils.RDF.GetResource("http://home.netscape.com/NC-rdf#BookmarkSeparator"),
                    true
                );
            }
            if ( sbCommonUtils.getPref("tree.unshift", false) ) {
                if ( aIdx == 0 || aIdx == -1 ) aIdx = 1;
            }
            if ( 0 < aIdx && aIdx <= cont.GetCount() ) {
                cont.InsertElementAt(newRes, aIdx, true);
            } else {
                cont.AppendElement(newRes);
            }
            
            //Associate any filesystem objects and write to them
	        switch (newItem.type) {
	            case "folder":
            		this.associateFilename(newRes); //choose a suitable FS name
            		this.needFolderDir(newRes);
            		break;
	            case "note":
	            	this.associateFilename(newRes);
	            	this.writeNoteFile(newRes);
	            	break;
	        }

            this._flushWithDelay();
            return newRes;
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
			sbCommonUtils.RDFC.Init(this._dataObj, curPar);
			sbCommonUtils.RDFC.RemoveElement(curRes, true);
        } catch(ex) {
            sbCommonUtils.alert(sbCommonUtils.lang("scrapbook", "ERR_FAIL_ADD_RESOURCE1", [ex]));
            return;
        }
        if ( sbCommonUtils.getPref("tree.unshift", false) ) {
            if ( tarRelIdx == 0 || tarRelIdx == -1 ) tarRelIdx = 1;
        }
        try {
            sbCommonUtils.RDFC.Init(this._dataObj, tarPar);
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
            sbCommonUtils.RDFC.Init(this._dataObj, sbCommonUtils.RDF.GetResource("urn:scrapbook:root"));
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
        if ( !this.validateURI(aResName) ) return;
        sbCommonUtils.RDFCU.MakeSeq(this._dataObj, sbCommonUtils.RDF.GetResource(aResName));
        this._flushWithDelay();
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
				sbCommonUtils.RDFC.Init(this._dataObj, aParRes);
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
        var names = this._dataObj.ArcLabelsOut(aRes);
        var rmID = this.getProperty(aRes, "id");
        sbCommonUtils.dbg("removeResource: removing "+rmID);
        while ( names.hasMoreElements() ) {
            try {
                var name  = names.getNext().QueryInterface(Components.interfaces.nsIRDFResource);
                var value = this._dataObj.GetTarget(aRes, name, true);
                this._dataObj.Unassert(aRes, name, value);
            } catch(ex) {
            	sbCommonUtils.log("removeResource: exception: "+ex);
            }
        }
        this._flushWithDelay();
        return rmID;
    },



    getContainer : function(aResURI, force) {
        var cont = Components.classes['@mozilla.org/rdf/container;1'].createInstance(Components.interfaces.nsIRDFContainer);
        try {
            cont.Init(this._dataObj, sbCommonUtils.RDF.GetResource(aResURI));
        } catch(ex) {
            if ( force ) {
                if ( !this.validateURI(aResURI) ) return null;
                return sbCommonUtils.RDFCU.MakeSeq(this._dataObj, sbCommonUtils.RDF.GetResource(aResURI));
            } else {
                return null;
            }
        }
        return cont;
    },

    clearContainer : function(ccResURI) {
        var ccCont = this.getContainer(ccResURI, true);
        var ccCount = ccCont.GetCount();
        for ( var ccI=ccCount; ccI>0; ccI-- ) {
            ccCont.RemoveElementAt(ccI, true);
        }
        this._flushWithDelay();
    },

    removeFromContainer : function(aResURI, aRes) {
        var cont = this.getContainer(aResURI, true);
        if ( cont ) cont.RemoveElement(aRes, true);
        this._flushWithDelay();
    },


    //When reading and writing items, we mostly just copy all the available properties.
    //Some properties are internal though and should be hidden from clients (or they may write their obsolete values back later).
    internalPropertyNames : ["filename"],

    //Reads all of resources's data, except for internal bookkeeping
    getItem : function(aRes) {
        var ns = sbCommonUtils.namespace, nsl = ns.length;
        var item = sbCommonUtils.newItem();
        var names = this._dataObj.ArcLabelsOut(aRes);
        while ( names.hasMoreElements() ) {
            try {
                var name  = names.getNext().QueryInterface(Components.interfaces.nsIRDFResource);
                if (name.Value.substring(0, nsl) != ns) continue;
                var key = name.Value.substring(nsl);
                if (this.internalPropertyNames.indexOf(key) >= 0)
                    continue; //internal properties should be skipped
                var value = this._dataObj.GetTarget(aRes, name, true).QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
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
            var retVal = this._dataObj.GetTarget(aRes, sbCommonUtils.RDF.GetResource(sbCommonUtils.namespace + aProp), true);
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
        	
            var oldVal = this._dataObj.GetTarget(aRes, aProp, true);
            if (oldVal == sbCommonUtils.RDF.NS_RDF_NO_VALUE) {
                this._dataObj.Assert(aRes, aProp, sbCommonUtils.RDF.GetLiteral(newVal), true);
            } else {
                oldVal = oldVal.QueryInterface(Components.interfaces.nsIRDFLiteral);
                newVal = sbCommonUtils.RDF.GetLiteral(newVal);
                this._dataObj.Change(aRes, aProp, oldVal, newVal);
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
    		var oldVal = this._dataObj.GetTarget(aRes, aProp, true);
            if (oldVal != sbCommonUtils.RDF.NS_RDF_NO_VALUE)
				this._dataObj.Unassert(aRes, aProp, oldVal);
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
            default         : return sbCommonUtils.getBaseHref(this._dataObj.URI) + "data/" + id + "/index.html";
        }
    },

    exists : function(aRes) {
        if ( typeof(aRes) == "string" ) {
            aRes = sbCommonUtils.RDF.GetResource("urn:scrapbook:item" + aRes);
        }
        return this._dataObj.ArcLabelsOut(aRes).hasMoreElements();
    },

    isolated : function(aRes) {
        return !this._dataObj.ArcLabelsIn(aRes).hasMoreElements();
    },

    isContainer : function(aRes) {
        return sbCommonUtils.RDFCU.IsContainer(this._dataObj, aRes);
    },
	
	//True if the resource represents a filesystem object (as opposed to purely virtual resources such as separators)
	isFilesystemObject : function(aRes) {
	    resType = this.getProperty(aRes, "type");
	    return ((resType == "folder") || (resType == "note"));
	},

	//True if the resource is logically a folder (not just by the virtue of having RDF children, though in practice these should match).
	isFolder : function(aRes) {
    	var resType = this.getProperty(aRes, "type");
    	return (resType == "folder") || (aRes.Value == "urn:scrapbook:root");
	},

	// Ensures that a given item ID is unused (altering it if needed)
    identify : function(aID) {
        while ( this.exists(aID) ) {
            aID = (parseInt(aID, 10) + 1).toString();
        }
        return aID;
    },

    getRelativeIndex : function(aParRes, aRes) {
        return sbCommonUtils.RDFCU.indexOf(this._dataObj, aParRes, aRes);
    },

    // aRule: 0 for any, 1 for containers (folders), 2 for items
    flattenResources : function(aContRes, aRule, aRecursive, aRecObj) {
        var resList = aRecObj || [];
        if ( aRule != 2 ) resList.push(aContRes);
        sbCommonUtils.RDFC.Init(this._dataObj, aContRes);
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
        var resEnum = this._dataObj.GetAllResources();
        while ( resEnum.hasMoreElements() ) {
            var res = resEnum.getNext().QueryInterface(Components.interfaces.nsIRDFResource);
            if ( !this.isContainer(res) ) continue;
            if ( res.Value == "urn:scrapbook:search" ) continue;
            if ( sbCommonUtils.RDFCU.indexOf(this._dataObj, res, aRes) != -1 ) return res;
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
        return filename.replace(/[\x00-\x1F\x7F\<\>\:\"\/\\\|\?\*]/g, " ");
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
    
    //Selects a filename for a resource and stores it in the resource properties, if needed.
    //Handles name sanitization and duplicates.
    //Once selected, the name will not be changed until this is called again (i.e. when moving to a new place).
    //Does not create the folder itself because this is used to choose the target filename when moving too.
    //If existingName is given, it is assumed to be ours (we'll not consider it taken if we stumble upon it)
    associateFilename : function(aRes, existingName) {
    	var aParent = this.findParentResource(aRes);
    	if (!aParent) throw "associateFilename: resource must be attached to a parent";
    	var parentDir = this.needFolderDir(aParent);
    	sbCommonUtils.dbg("associateFilename: parent directory retrieved");
    	
    	var resType = this.getProperty(aRes, "type");
    	switch(resType) {
    		case "folder": var ext = ""; break;
    		case "note": var ext = "txt"; break;
    		case "bookmark": var ext = "url"; break;
    		default: throw "associateFilename: unsupported resource type: "+resType;
    	}
    	
    	var title = this.getProperty(aRes, "title");
    	if (title == "") {
    		title = resType; //if title is empty, use "Note.txt"
    		if (title == "") //just in case
    			title = "Resource";
    	}
    	
    	var filename = this.selectUniqueFilename(parentDir, this.sanitizeFilename(title), ext, existingName);
    	if (filename != title)
    		//Chosen name was different from the title. We need to store it as an additional attribute.
    		this.setInternalProperty(aRes, "filename", filename)
    	else
    		this.clearProperty(aRes, "filename"); //if any was set
    	sbCommonUtils.dbg("associateFilename: "+filename);
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
    needFolderDir : function(folderRes) {
    	if (!this.isFolder(folderRes)) throw "needFolderDir: not a folder but "+this.getProperty(folderRes, "type");
    	var path = this.getAssociatedFsObject(folderRes);
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
	
	
	//Outputs note contents to an associated file
	writeNoteFile : function(aNoteRes) {
		//TODO: Implement.
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