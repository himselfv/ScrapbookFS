Components.utils.import("resource://scrapbook-modules/common.jsm");

/*
Fake RDF data source.
This version of Scrapbook does not use an RDF file interally. But many modules rely on it,
and most of all, Firefox tree component needs an RDF source.
Therefore we build a fake RDF source in sync with the real data.

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
        this._dataObj = Components.classes["@mozilla.org/rdf/datasource;1?name=xml-datasource"].createInstance(Components.interfaces.nsIRDFDataSource);
        this._dataObj.URI = Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService).newFileURI(sbCommonUtils.getScrapBookDir()).spec; //some rely on this field
        sbCommonUtils.dbg('this._dataObj.URI = '+this._dataObj.URI);
        sbCommonUtils.RDFCU.MakeSeq(this._dataObj, sbCommonUtils.RDF.GetResource("urn:scrapbook:root"));
        sbCommonUtils.dbg('sbRDF.init() over');
	},
	
	clear : function() {
		this.init(); //just reinit
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