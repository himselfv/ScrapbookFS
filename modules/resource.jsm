Components.utils.import("resource://scrapbook-modules/common.jsm");
Components.utils.import("resource://scrapbook-modules/fakerdf.jsm");
Components.utils.import("resource://scrapbook-modules/dirindex.jsm");


/*
  A filesystem resource.

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
    Resource(null, "folder", fso); //auto-generate
    Resource("urn:scrapbook:item12345678901234", ...); //use explicit

  There are filesytem resources and virtual resources (e.g. separators).
  Every filesystem resource must have associated filesystem object. This object always points
  to the resource data, wherever it is.
  Virtual resources might not have an FSO. For example, a separator has no FSO.
  
  When moving the resources, the data manager moves the entry, regenerates the FSO
  and moves the data.
*/
function Resource(rdfId, type, fso) {
	sbCommonUtils.dbg('Resource('+rdfId+','+type+','+fso+')');
	this.rdfId = rdfId;
	this.type = type;
	this._FSO = fso;
	if (this._FSO && (type != "root"))
		this._filename = this._FSO.leafName;
	else
		this._filename = "";
	this.children = [];
	this.registerRdf();
	sbDataSource.nodes.push(this); //auto-register us in a node list
}

Resource.prototype = {
	parent : null,
	type : null, //root, folder, note, ...

	_filename : null,
	get filename() { return this._filename; },
	//Note: this does NOT move the item, moving of the actual resources is handled by sbDataSource
	set filename(fname) {
		this._filename = fname;
		if (this.parent)
			this.parent._childFilenameTitleChanged(this);
	},


	_FSO : null, //explicit filesystem object
	getFilesystemObject : function() {
		return this._FSO
	},
	//Recalculate FSO from parent + filename
	updateFSO : function() {
		var FSO = this.parent.getFilesystemObject().clone();
		FSO.append(this.filename);
		this.FSO = FSO;
	},
	
	get isRoot() {
		return (this.type == "root")
	},
	
	get isFilesystemObject() {
		return (this.type != "separator");
	},

	//Represents a folder on disk
	get isFolder() {
		return (this.type == "folder") || (this.type == "root");
	},
	
	//Can contain child items
	get isContainer() {
		return this.isFolder;
	},



	_title : null, //explicit title, if overriden

	getTitle : function() {
		sbCommonUtils.dbg("getTitle()");
		//If we have overriden title, use that
		if (this._title != null) {
			sbCommonUtils.dbg("returning "+this._title);
			return this._title;
		}
		return this._getFilenameTitle();
	},
	
	//Returns filename of this Resource without extension, as it will be used for title
	//if it is not overriden
	//Also useful to check if it's overriden.
	_getFilenameTitle : function() {
		sbCommonUtils.dbg("getFilenameTitle: _filename="+this._filename);
		//Strip extension
		var parts = this.filename.split('.');
		if ((parts.length < 2) || (parts.pop().length > 5)) {
			sbCommonUtils.dbg("returning "+this.filename);
			return this.filename //probably wasn't an extension
		}
		else {
			sbCommonUtils.dbg("returning "+parts.join('.'));
			return parts.join('.');
		}
	},
	
	//Sets title override. If this is null, filename is used as title.
	//Use when the filename which you assign in create/rename/move cannot be represented by FS or conflicts with existing one.
	setCustomTitle : function(aTitle) {
		sbCommonUtils.dbg("setCustomTitle: '"+aTitle+"'");
		this._title = aTitle;
		if (this.parent)
			this.parent._childFilenameTitleChanged(this);
		sbRDF.setProperty(this.rdfRes, 'title', this.getTitle()); //update RDF
	},
	
	
	/*
	Every folder has an index file which stores:
	- the order of children
	- children altnames (which they could or couldn't store internally)
	- properties the children couldn't store internally
	
	When loading the folder, we read the index (if present), and initialize any children
	declared therein. From there on, each child stores its own properties and calls back
	when those are changed.
	
	When child properties are changed, we rebuild the index and write it down.
	
	When children are detached, they take the properties with them. Once attached back,
	they trigger the rebuild of the index.
	
	TODO: We'd prefer to store the index in desktop.ini, this will allow us to store some
	  properties in a compatible manner (this folder's icon and title; children titles).
	  This will require us though to preserve the other content that might be there
	  (we can't just rebuild the file from the scratch).
	*/

	//Loads index.dat for the directory FSO into ordered {id,title} pairs
	_loadIndex : function (fso) {
		var index = new DirIndex();
		if (fso)
			var file = fso.clone()
		else
			var file = this.getFilesystemObject().clone();
		file.append("index.dat");
		if (file.exists()) {
			index.loadFromFile(file);
			sbCommonUtils.dbg("_loadIndex: "+index.entries.length+" entries loaded");
		}
		return index;
	},
	_compileIndex : function() {
		var entries = [];
		sbCommonUtils.dbg("updateIndex: "+this.children.length+" children found");
		for (var i=0; i<this.children.length; i++) {
			sbCommonUtils.dbg("updateIndex: "+this.children[i].type+','+this.children[i].filename);
			var entry = {};
			switch (this.children[i].type) {
			case "separator":
				entry.id = '***';
				entry.title = null;
				break;
			default:
				entry.id = this.children[i].filename;
				var title = this.children[i].getTitle();
				if (title != this.children[i]._getFilenameTitle())
					entry.title = title;
				else
					entry.title = null;
				sbCommonUtils.dbg("updateIndex: querying external properties");
				entry.props = this.children[i]._getExternalProperties();
				sbCommonUtils.dbg("updateIndex: "+entry.props.length+" properties returned");
			}
			entries.push(entry);
		}
		var index = new DirIndex();
		index.entries = entries;
		return index;
	},

	//Writes any changed resources to the disk.
	//By default this is only triggered when something has changed, so we may be lazy with dirty detection.
	flush : function() {
		sbCommonUtils.dbg("Resource.flush()");
		if (this.isFolder) {
			var index = this._compileIndex();
			if (index) {
				var file = this.getFilesystemObject().clone();
				file.append("index.dat");
				index.saveToFile(file);
			}
		}
	},

	//Queues writing any changed resources to disk
	queueFlush : function() {
		sbFlushService.queue(this);
	},
	
	
	
	// Generic properties
	// As a rule, we store whatever we can in the file itself (depending on its type),
	// and everything else offload to parent's index file.
	// Index must be read before loading any children.
	// When attaching children, parent will pass all related stored properties to each.
	
	__comment : null,
	// Internal access: stores the value and updates the RDF
	get _comment() { return this.__comment; },
	set _comment(aValue) {
		if (this.__comment == aValue) return;
		this.__comment = aValue;
		sbRDF.setProperty(this.rdfRes, 'comment', aValue);
	},
	// External access: writes the value down to disk
	get comment() {	return this._comment; },
	set comment(aValue) {
		sbCommonUtils.dbg("setComment: '"+aValue+"'");
		if (this._comment == aValue) return;
		switch (this.type) {
		//Some file types might be able to store comment internally
		default:
			if (this.parent) this.parent._storeChildProperty(this, "comment", aValue);
		}
	},

	__icon : null,
	//Internal access
	get _icon() { return this.__icon; },
	set _icon(aValue) {
		if (this.__icon == aValue) return;
		this.__icon = aValue;
		sbRDF.setProperty(this.rdfRes, 'icon', aValue);
	},
	//External access
	get icon() { return this._icon; },
	set icon(aValue) {
		sbCommonUtils.dbg("setIcon: '"+aValue+"'");
		if (this._icon == aValue) return;
		this._icon = aValue;
		switch (this.type) {
		//Some file types might be able to store icon selection internally
		default:
			if (this.parent) this.parent._storeChildProperty(this, "icon", aValue);
		}
	},
	
	__source : null,
	//Internal access
	get _source() { return this.__source; },
	set _source(aValue) {
		if (this.__source == aValue) return;
		this.__source = aValue;
		sbRDF.setProperty(this.rdfRes, 'source', aValue);
	},
	//External access
	get source() { return this._source; },
	set source(aValue) {
		sbCommonUtils.dbg("setSource: '"+aValue+"'");
		if (this._source == aValue) return;
		this._source = aValue;
		switch (this.type) {
		//Some file types might be able to store icon selection internally
		default:
			if (this.parent) this.parent._storeChildProperty(this, "source", aValue);
		}
	},
	
	// Lock is always stored as "read-only" flag
	get lock() {
		// Note that on Windows, read-only flag has a different meaning for folders: "this folder
		// has custom desktop.ini".
		// nsIFile should abstract this away, but does it really?
		// Luckily, locks for folders are not supported in Scrapbook, so let's be safe:
		if (this.isFolder) return false;
		if (this.isFilesystemObject)
			return !this.getFilesystemObject().isWritable();
		else
			return false;
	},
	set lock(aValue) {
		sbCommonUtils.dbg("set lock: "+aValue);
		if (this.isFolder) return;
		if (this.isFilesystemObject) {
			var perm = aValue ? 0400 : 0700;
			sbCommonUtils.dbg("set lock: setting permissions="+perm);
			this.getFilesystemObject().permissions = perm;
			sbCommonUtils.dbg("set lock: permissions="+this.getFilesystemObject().permissions);
			sbRDF.setProperty(this.rdfRes, 'lock', aValue ? "true" : "false");
		}
	},
	
	// Creation and modification times are always read-only. FS tracks these.
	get createTime() {
		sbCommonUtils.dbg("createTime");
		return this.modifyTime; //TODO: Is there no way to query creation time?
	},
	get modifyTime() {
		sbCommonUtils.dbg("modifyTime");
		if (this.isFilesystemObject) {
			var modifyTime = this.getFilesystemObject().lastModifiedTime;
			return sbCommonUtils.getTimeStamp(new Date(modifyTime));
		}
		else {
			sbCommonUtils.dbg("modifyTime: this.parent");
			return (!this.parent) ? "" : this.parent.modifyTime; //for separators etc.
			sbCommonUtils.dbg("modifyTime: this.parent2");
		}
	},
	
	
	//Returns a list of properties this child cannot store internally and which
	//must be stored by its parent.
	_getExternalProperties : function() {
		var props = [];
		sbCommonUtils.dbg("_getExternalProperties: comment="+this.comment);
		sbCommonUtils.dbg("_getExternalProperties: icon="+this.icon);
		sbCommonUtils.dbg("_getExternalProperties: source="+this.source);
		//TODO: some types of files can store these internally
		if (this.comment) props.push({name: "comment", value: this.comment});
		if (this.icon) props.push({name: "icon", value: this.icon});
		if (this.source) props.push({name: "source", value: this.source});
		return props
	},
	
	//This is called by parent when attaching a child. All generic stored properties are passed here.
	//Some properties have their own routines (such as title).
	_loadExternalProperty : function(aProp, aValue) {
		sbCommonUtils.dbg("_loadExternalProperty: "+aProp+"="+aValue);
		switch(aProp) {
		case "comment": this._comment = aValue; sbCommonUtils.dbg("comment: "+this.comment); break;
		case "icon": this._icon = aValue; break;
		case "source": this._source = aValue; break;
		default: break; //other are unsupported
		}
	},

	//Called by children when one of their generic properties is changed and their format has nowhere to store it.
	_storeChildProperty : function(aChild, aProp, aValue) {
		//Flush will ask children what to store
		if (!this._loadingChildren)
			this.queueFlush();
	},

	// Called when the title or the filename changes. These two are interdependent, so one callback
	_childFilenameTitleChanged(child) {
		sbCommonUtils.dbg("Resource.childFilenameTitleChanged()");
		if (!this._loadingChildren)
			this.queueFlush();
	},




	// Children 
	children : null,
	_loadingChildren : false, //if set, ignore children callbacks about title changes, that's us

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
		sbCommonUtils.dbg("insertChild: at="+index);
		var cont = this.rdfCont();
		if ( 0 <= index && index < this.children.length ) {
			this.children.splice(index, 0, child);
			cont.InsertElementAt(child.rdfRes, index+1, true); //RDF is indexed starting with 1
		} else {
			this.children.push(child);
			cont.AppendElement(child.rdfRes);
		}
		child.parent = this;
		if (!this._loadingChildren)
			this.queueFlush();
	},
	
	removeChild : function(child) {
		var index = this.indexOfChild(child);
		if (index < 0) throw "removeChild: Child not found";
		return this.removeChildByIndex(index);
	},
	removeChildByIndex : function(index) {
		var cont = this.rdfCont();
		var child = this.children.splice(index, 1);
		cont.RemoveElement(child[0].rdfRes, true); //safer to remove by resource than by index
		child.parent = null;
		if (!this._loadingChildren)
			this.queueFlush();
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
		Standard RDF properties and their handling:
	       NS1:id="20160403063754"				read-only, set on creation
	       NS1:create="20160403063754"          read-only, from FS / not availabe for separators
	       NS1:modify="20160403063754"          -- // --
	       NS1:type="note"                      read-only, set on creation / by file type
	       NS1:title=""                         read-write, triggers file move
	       NS1:chars="UTF-8"                    read-only, always UTF-8 (for now). We may handle other encodings later, but so far as clients are concerned, we'll still present as UTF-8.
	       NS1:icon=""                          read-write, stored in resource / index
	       NS1:source=""                        read-write, stored in resource / index
	       NS1:comment=""                       read-write, stored in resource / index
	       NS1:lock=""                          read-write, stored as file attribute "read-only" (if this property is what I think it is)
		*/
		sbRDF.setProperty(this.rdfRes, 'id', this.rdfId);
		sbRDF.setProperty(this.rdfRes, 'create', this.createTime);
		sbRDF.setProperty(this.rdfRes, 'modify', this.modifyTime);
		sbRDF.setProperty(this.rdfRes, 'type', this.type);
		if (this.type != "separator") {
			sbRDF.setProperty(this.rdfRes, 'title', this.getTitle());
			sbRDF.setProperty(this.rdfRes, 'chars', "UTF-8"); //TODO?
		}
		sbRDF.setProperty(this.rdfRes, 'icon', this.icon);
		sbRDF.setProperty(this.rdfRes, 'source', this.source);
		sbRDF.setProperty(this.rdfRes, 'comment', this.comment);
		sbRDF.setProperty(this.rdfRes, 'lock', this.lock ? "true" : "false");
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


/*
Flush service.
Queues data write requests and processes them in a timely manner.
Usage:
  sbFlushService.queue(Resource)
*/

var sbFlushService = {
	_initialized : false,
	_flushQueue : [],
	
	_init : function() {
		if (!this._initialized) {
			var obs = Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService);
			obs.addObserver(this, "quit-application-requested", false);
		}
	},
	_uninit : function() {
		this.flush();
	},

	observe : function(aSubject, aTopic, aData) {
		switch (aTopic) {
			case "timer-callback": 
				this.flush();
				break;
			case "quit-application-requested": 
				this._uninit();
				break;
			default: 
		}
	},
	
	queue : function (item) {
		sbCommonUtils.dbg("sbFlushService.queue()");
		if (this._flushQueue.indexOf(item) < 0) //don't push twice
			this._flushQueue.push(item);
		if (!this._initialized) this._init();
		if (!this._flushTimer) {
			this._flushTimer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
			// this.observe is called when time's up
			this._flushTimer.init(this, 4000, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
		}
	},
	
	flush : function () {
		if (this._flushTimer) {
			this._flushTimer.cancel();
			this._flushTimer = null;
		}
		sbCommonUtils.dbg("sbFlushService.flush()");
		try {
			while (this._flushQueue.length > 0) {
				this._flushQueue[0].flush();
				this._flushQueue.splice(0, 1);
			}
		} catch(ex) {
			sbCommonUtils.error(ex);
		}
	},
}

var EXPORTED_SYMBOLS = ["sbFlushService"];