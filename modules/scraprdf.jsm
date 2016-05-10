Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://scrapbook-modules/common.jsm");
Components.utils.import("resource://scrapbook-modules/resource.jsm");


/*
Scrapbook RDF data source.
This version of Scrapbook does not use an RDF file interally. But many modules rely on it,
and most of all, Firefox tree component needs an RDF source.
Therefore we implement RDF data source over data.

This module is self-initializing, self-registering. The only thing datasource.jsm does is
forwards .data() and .url() calls to us.

URNs need to be in the form
  urn:scrapbook:root
  urn:scrapbook:item[14 digits]
*/

var sbRDF = {
	
    _dataObj : null,
    get data() {
    	sbCommonUtils.dbg('sbRDF.getData()');
        return this._dataObj;
    },

	//Called by outside clients
	init : function() {
		sbCommonUtils.dbg('sbRDF.init()');
        this._dataObj = (new ScrapbookDatasource()).QueryInterface(Components.interfaces.nsIRDFDataSource);
        //Components.classes["@mozilla.org/rdf/datasource;1?name=scrapbook-fs-datasource"].createInstance(Components.interfaces.nsIRDFDataSource);
        sbCommonUtils.RDFCU.MakeSeq(this._dataObj, sbCommonUtils.RDF.GetResource("urn:scrapbook:root"));
        sbCommonUtils.dbg('sbRDF.init() over');
	},
	
	uninit : function() {
        this._dataObj = null;
    },


    //Ids
    
    //Generates a random old-style ID
    newId : function() {
    	var s = '';
    	for (var i = 0; i < 14; i++)
    		s = s + Math.floor((Math.random() * 10)).toString(); //whatever
    	return s;
    },
    
    validateURI : function(aURI) {
        if ( aURI == "urn:scrapbook:root" || aURI == "urn:scrapbook:search" || aURI.match(/^urn:scrapbook:item\d{14}$/) ) {
            return true;
        } else {
            return false;
       	}
    },
    

    // Containers
    
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

     createEmptySeq : function(aResName) {
        if ( !this.validateURI(aResName) ) return;
        sbCommonUtils.RDFCU.MakeSeq(this._dataObj, sbCommonUtils.RDF.GetResource(aResName));
     },


	// Properties
    getProperty : function(aRes, aProp) {
        if ( aRes.Value == "urn:scrapbook:root" ) return "";
        try {
            var retVal = this._dataObj.GetTarget(aRes, sbCommonUtils.RDF.GetResource(sbCommonUtils.namespace + aProp), true);
            return retVal.QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
        } catch(ex) {
            return "";
        }
    },
	
    setProperty : function(aRes, aProp, newVal) {
        var aPropName = aProp;
        aProp = sbCommonUtils.RDF.GetResource(sbCommonUtils.namespace + aPropName);
        try {
            var oldVal = this._dataObj.GetTarget(aRes, aProp, true);
            if (oldVal == sbCommonUtils.RDF.NS_RDF_NO_VALUE) {
                this._dataObj.Assert(aRes, aProp, sbCommonUtils.RDF.GetLiteral(newVal), true);
            } else {
                oldVal = oldVal.QueryInterface(Components.interfaces.nsIRDFLiteral);
                newVal = sbCommonUtils.RDF.GetLiteral(newVal);
                this._dataObj.Change(aRes, aProp, oldVal, newVal);
            }
        } catch(ex) {
            sbCommonUtils.error(ex);
        }
    },
};

var EXPORTED_SYMBOLS = ["sbRDF"];



/*
Scrapbook RDF data source implementation.
We don't do proper registration because we don't need to create it from outside, we only need it to be compatible.
See http://lxr.mozilla.org/seamonkey/source/rdf/base/idl/nsIRDFDataSource.idl
*/

function ScrapbookDatasource() {
	sbCommonUtils.dbg("ScrapbookDatasource()");
	this.init();
}

ScrapbookDatasource.prototype = {
	classDescription: "ScrapbookX data source",
	classID:          Components.ID("{C8DCBAC4-43E0-4B57-A82E-E32C713D9882}"),
	contractID:       "@mozilla.org/rdf/datasource;1?name=scrapbook-fs-datasource",
    QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsIRDFDataSource]),

	rdf : null, //nsIRDFService
	uplink : null, //the datasource we channel most of the commands to, currently

	init : function() {
		sbCommonUtils.dbg("ScrapbookDatasource.init()");
		this.rdf = Components.classes["@mozilla.org/rdf/rdf-service;1"].getService(Components.interfaces.nsIRDFService);
		this.uplink = Components.classes["@mozilla.org/rdf/datasource;1?name=in-memory-datasource"].createInstance(Components.interfaces.nsIRDFDataSource);
		this.resmap = new Object();
	},
	
	
	//Some rely on URI field pointing to Scrapbook data file, so we have to emulate this.
	_URI : null,
	get URI() {
		if (!this._URI) {
			var dataFile = sbCommonUtils.getScrapBookDir();
			dataFile.append("scrapbook.rdf");
			this._URI = Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService).newFileURI(dataFile).spec;
		}
		sbCommonUtils.dbg('this.URI = '+this._URI);
		return this._URI;
	},


	/*
	RDF Datasource operates with RDF Resources. We operate with our internal SB Resources().
	This maps one to another.
	*/
	resmap : null,
	
	// Registers SB Resource and returns RDF Resource which will represent it.
	// Every SB Resource needs to be registered before using.
	registerSbResource : function(aSbRes) {
		if (!aSbRes.rdfUri)
			aSbRes.rdfUri = 'urn:scrapbook:item'+sbRDF.newId();
		var rdfRes = this.rdf.GetResource(aSbRes.rdfUri);
		this.resmap[rdfRes] = aSbRes;
		return rdfRes;
	},
	getSbResource : function(aRdfRes) {
		return this.resmap[aRdfRes]; //may be null
	}


	//Implement the rest of IRDFDataSource by proxy
	
	// Get any resource with property aProperty equal to value aTarget (ignore aTruthValue)
	GetSource : function(aProperty, aTarget, aTruthValue) { return this.uplink.GetSource(aProperty, aTarget, aTruthValue); },
	// Get all resources with property aProperty equal to value aTarget (ignore aTruthValue)
	GetSources : function(aProperty, aTarget, aTruthValue) { return this.uplink.GetSources(aProperty, aTarget, aTruthValue); },
	
	// Get the value of a property aProperty for resource aSource (ignore aTruthValue)
	GetTarget : function(aSource, aProperty, aTruthValue) { return this.uplink.GetTarget(aSource, aProperty, aTruthValue); },
	// Get all entries for a property aProperty for resource aSource
	GetTargets : function(aSource, aProperty, aTruthValue) { return this.uplink.GetTargets(aSource, aProperty, aTruthValue); },
	
	// Add the property aProperty for resouce aSource, with value aTarget (ignore aTruthValue)
	Assert : function(aSource, aProperty, aTarget, aTruthValue) {
		this.uplink.Assert(aSource, aProperty, aTarget, aTruthValue);
		for observer in this.observers
			observer.onAssert(this, aSource, aProperty, aTarget); //observers don't receive aTruthValue
		return;
	},
	// Remove the property
	Unassert : function(aSource, aProperty, aTarget) {
		this.uplink.Unassert(aSource, aProperty, aTarget);
		for observer in this.observers
			observer.onUnassert(this, aSource, aProperty, aTarget);
		return;
	},
	// Change the value of the property aProperty for aSource from aOldTarget to aNewTarget
	Change : function(aSource, aProperty, aOldTarget, aNewTarget) {
		this.uplink.Change(aSource, aProperty, aOldTarget, aNewTarget);
		for observer in this.observers
			observer.onChange(this, aSource, aProperty, aOldTarget, aNewTarget);
		return;
	},
	// Remove the property aProperty from resource aOldSource and set it for aNewSource
	// Not very useful in our scenario, but whatever
	Move : function(aOldSource, aNewSource, aProperty, aTarget) {
		this.uplink.Move(aOldSource, aNewSource, aProperty, aTarget);
		for observer in this.observers
			observer.onMove(this, aOldSource, aNewSource, aProperty, aTarget);
		return;
	},
	// Check if resource aSource has property aProperty set to the value aValue
	HasAssertion : function(aSource, aProperty, aTarget, aTruthValue) { return this.uplink.HasAssertion(aSource, aProperty, aTarget, aTruthValue); },
	
	
	/*
	Adds-removes observers which have to be called on some operations.
	See http://lxr.mozilla.org/seamonkey/source/rdf/base/idl/nsIRDFObserver.idl
	*/
	var observers = [],
	AddObserver : function(aObserver) {
		this.observers.push(aObserver);
	},
	RemoveObserver : function(aObserver) {
		var index = this.observers.indexOf(aObserver);
		if (index >= 0)
			this.observers.splice(index, 1);
	},

	// Enumerate all resources which have any property with a given value.
	// Not very useful in our case
	ArcLabelsIn : function(aNode) { return this.uplink.ArcLabelsIn(aNode); },
	// Enumerate all properties of a resource
	ArcLabelsOut : function(aSource) { return this.uplink.ArcLabelsOut(aSource); },
	
	// Enumerate all resources and property values...
	GetAllResources : function() { return this.uplink.GetAllResources(); },
	IsCommandEnabled : function(aSources, aCommand, aArguments) { return this.uplink.IsCommandEnabled(aSources, aCommand, aArguments); },
	DoCommand : function(aSources, aCommand, aArguments) { return this.uplink.DoCommand(aSources, aCommand, aArguments); },
	GetAllCmds : function(aSource) { return this.uplink.GetAllCmds(aSource); },


	hasArcIn : function(aNode, aArc) { return this.uplink.hasArcIn(aNode, aArc); },
	hasArcOut : function(aSource, aArc) { return this.uplink.hasArcOut(aSource, aArc); },


	/*
	Either the datasource itself or any external clients may notify us and all the observers
	that there are going to be several operations at once.
	If we are to care about it beyond notifying the observers, we'll have to keep entry count.
	*/

	beginUpdateBatch : function() {
		for observer in this.observers
			observer.beginUpdateBatch(this);
		return;
	},
	endUpdateBatch : function() {
		for observer in this.observers
			observer.endUpdateBatch(this);
		return;
	},
}

/*
//Register the component
var components = [ScrapbookDatasource];
if ("generateNSGetFactory" in XPCOMUtils)
  var NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
else
  var NSGetModule = XPCOMUtils.generateNSGetModule(components);
*/