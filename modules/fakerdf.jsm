Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://scrapbook-modules/common.jsm");

/*
Fake RDF data source.
This version of Scrapbook does not use an RDF file interally. But many modules rely on it,
and most of all, Firefox tree component needs an RDF source.
Therefore we build a fake RDF source in sync with the real data. Once a file object is
discovered, renamed or moved, we update this in-memory representation.

Perhaps one day we'll implement our own full-blown IRDFDataSource with an added benefit of
being able to read data on request. But for now we'll stick with this.

We'll try to keep RDF data object as compatible as possible.

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
At this point just channels the requests to in-memory data source, but alters some that we need.
We don't do proper registration because we don't need to create it from outside, we only need it to be compatible.
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
    	
	uplink : null, //the datasource we channel most of the commands to, currently
	init : function() {
		sbCommonUtils.dbg("ScrapbookDatasource.init()");
		this.uplink = Components.classes["@mozilla.org/rdf/datasource;1?name=in-memory-datasource"].createInstance(Components.interfaces.nsIRDFDataSource);
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

	//Implement the rest of IRDFDataSource by proxy
	//See http://lxr.mozilla.org/seamonkey/source/rdf/base/idl/nsIRDFDataSource.idl
	GetSource : function(aProperty, aTarget, aTruthValue) { return this.uplink.GetSource(aProperty, aTarget, aTruthValue); },
	GetSources : function(aProperty, aTarget, aTruthValue) { return this.uplink.GetSources(aProperty, aTarget, aTruthValue); },
	GetTarget : function(aSource, aProperty, aTruthValue) { return this.uplink.GetTarget(aSource, aProperty, aTruthValue); },
	GetTargets : function(aSource, aProperty, aTruthValue) { return this.uplink.GetTargets(aSource, aProperty, aTruthValue); },
	Assert : function(aSource, aProperty, aTarget, aTruthValue) { return this.uplink.Assert(aSource, aProperty, aTarget, aTruthValue); },
	Unassert : function(aSource, aProperty, aTarget) { return this.uplink.Unassert(aSource, aProperty, aTarget); },
	Change : function(aSource, aProperty, aOldTarget, aNewTarget) { return this.uplink.Change(aSource, aProperty, aOldTarget, aNewTarget); },
	Move : function(aOldSource, aNewSource, aProperty, aTarget) { return this.uplink.Move(aOldSource, aNewSource, aProperty, aTarget); },
	HasAssertion : function(aSource, aProperty, aTarget, aTruthValue) { return this.uplink.HasAssertion(aSource, aProperty, aTarget, aTruthValue); },
	AddObserver : function(aObserver) { return this.uplink.AddObserver(aObserver); },
	RemoveObserver : function(aObserver) { return this.uplink.RemoveObserver(aObserver); },
	ArcLabelsIn : function(aNode) { return this.uplink.ArcLabelsIn(aNode); },
	ArcLabelsOut : function(aSource) { return this.uplink.ArcLabelsOut(aSource); },
	GetAllResources : function() { return this.uplink.GetAllResources(); },
	IsCommandEnabled : function(aSources, aCommand, aArguments) { return this.uplink.IsCommandEnabled(aSources, aCommand, aArguments); },
	DoCommand : function(aSources, aCommand, aArguments) { return this.uplink.DoCommand(aSources, aCommand, aArguments); },
	GetAllCmds : function(aSource) { return this.uplink.GetAllCmds(aSource); },
	hasArcIn : function(aNode, aArc) { return this.uplink.hasArcIn(aNode, aArc); },
	hasArcOut : function(aSource, aArc) { return this.uplink.hasArcOut(aSource, aArc); },
	beginUpdateBatch : function() { return this.uplink.beginUpdateBatch(); },
	endUpdateBatch : function() { return this.uplink.endUpdateBatch(); },
}

/*
//Register the component
var components = [ScrapbookDatasource];
if ("generateNSGetFactory" in XPCOMUtils)
  var NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
else
  var NSGetModule = XPCOMUtils.generateNSGetModule(components);
*/