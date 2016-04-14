Components.utils.import("resource://scrapbook-modules/common.jsm");

/*
Directory index file format.

Index serves as a supplementary place to store information which could not be stored in the file format itself.

*/


function DirIndex() {
	this.entries = [];
}

DirIndex.prototype = {
	entries : null,
	
	//Property names are well-known, but just in case let's have this.
	_sanitizePropName : function(aValue) {
		return aValue.replace(/[\x00-\x1F\x7F\<\>\:\"\/\\\|\?\*\=]/g, "");
	},
	
	//Encodes and decodes property values and replacement titles
	_encodePropValue : function(aValue) {
		//For now we just remove the offending symbols, these shouldn't be in the known properties anyway.
		return aValue.replace(/[\x00-\x1F]/g, "");
	},
	_decodePropValue : function(aValue) {
		//See _encodePropValue
		return aValue;
	},

	loadFromFile : function(aFile) {
		sbCommonUtils.dbg("index.load: "+aFile.path);
		this.entries = [];
		var lines = sbCommonUtils.readFile(aFile).replace(/\r\n|\r/g, '\n').split("\n");
		var section = "";
		for (var i=0; i<lines.length; i++) {
			var line = lines[i];
			if (line == "") continue; //safety
			if ((line[0] == "[") && (line[line.length] == "]")) {
				section = line.slice(1, line.length-2);
				continue;
			}
			
			switch (section) {
			case "":
			case "Index":
				sbCommonUtils.dbg("Index entry: "+lines[i]);
				var parts = lines[i].split('=');
				this.entries.push({
				  id: parts.shift(),
				  title: this._decodePropValue(parts.join("="))
				});
				break;
			case "Properties":
				sbCommonUtils.dbg("Property entry: "+lines[i]);
				var parts = lines[i].split('=');
				if (parts.length < 1) throw "Invalid index property entry: "+parts.join('=');
				var id_parts = parts.shift().split(':');
				if (id_parts.length != 2) throw "Invalid index property name: "+id_parts.join(':');
				this.setProperty(id_parts[0], id_parts[1], parts.join('='));
				break;
			}
		}
		sbCommonUtils.dbg("index loaded, "+this.entries.length+" entries");
	},
	saveToFile : function(aFile) {
		sbCommonUtils.dbg("index.write: "+aFile.path);
		var lines = [];
		// Index
		for (var i=0; i<this.entries.length; i++) {
			if (this.entries[i].title)
				lines.push(this.entries[i].id+'='+this._encodePropValue(this.entries[i].title));
			else
				lines.push(this.entries[i].id);
		}
		// Properties
		for (var i=0; i<this.entries.length; i++) {
			var entry = this.entries[i];
			if (!entry.props) continue;
			for (var j=0; j<entry.props.length; j++)
				lines.push(entry.id+':'+this._sanitizePropName(entry.props[j].name)+'='+this._encodePropValue(entry.props[j].value));
		}
		sbCommonUtils.writeFile(aFile, lines.join("\r\n"));
	},

	getEntry : function(aEntryName) {
		for (var i=0; i<this.entries.length; i++)
			if (this.entries[i].id == aEntryName)
				return this.entries[i];
		var idx = this.entries.push({id: aEntryName});
		return this.entries[idx];
	},

	getProperty : function(aEntryName, aPropName) {
		var entry = this.getEntry(aEntryName);
		if (!entry.props)
			return null;
		for (var i=0; i<entry.props.length; i++)
			if (entry.props[i].name == aPropName)
				return entry.props[i].value;
		return null;
	},
	setProperty : function(aEntryName, aPropName, aValue) {
		var entry = this.getEntry(aEntryName);
		if (!entry.props)
			entry.props = [];
		for (var i=0; i<entry.props.length; i++)
			if (entry.props[i].name == aPropName) {
				entry.props[i].value = aValue;
				return;
			}
		entry.props.push({name: aPropName, value: aValue});
	},
}

function LoadDirIndex(filename) {
	sbCommonUtils.dbg("Loading dirindex: "+filename.path)
	var index = new DirIndex();
	index.loadFromFile(filename);
	return index;
}


var EXPORTED_SYMBOLS = ["DirIndex", "LoadDirIndex"];
