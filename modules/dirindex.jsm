Components.utils.import("resource://scrapbook-modules/common.jsm");

/*
Directory index file format.
*/


function DirIndex() {
	this.entries = [];
}

DirIndex.prototype = {
	entries : null,

	loadFromFile : function(aFile) {
		sbCommonUtils.dbg("index.load: "+aFile.path);
		this.entries = [];
		var lines = sbCommonUtils.readFile(aFile).replace(/\r\n|\r/g, '\n').split("\n");
		var section = "";
		for (var i=0; i<lines.length; i++) {
			var line = lines[i];
			if (line == "") continue; //safety
			if (line[0] == "[") && (line[line.length] == "]") {
				section = line.slice(1, line.length-2);
				continue;
			}
			
			switch (section) {
			case "":
			case "Index":
				var parts = lines[i].split('=');
				this.entries.push({
				  id: parts.shift(),
				  title: parts.join("=")
				});
				break
			case "Properties":
				var parts = lines[i].split('=');
				var id_parts = parts.shift().split('.');
				
				
				this.setProperty()
				break;
			}
			

		}
	},
	saveToFile : function(aFile) {
		sbCommonUtils.dbg("index.write: "+aFile.path);
		var lines = [];
		for (var i=0; i<this.entries.length; i++) {
			if (this.entries[i].title)
				lines.push(this.entries[i].id+'='+this.entries[i].title);
			else
				lines.push(this.entries[i].id);
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

function LoadDirIndex(filename) = {
	sbCommonUtils.dbg("Loading dirindex: "+filename.path)
	var index = new DirIndex();
	index.loadFromFile(filename);
	return index;
}


var EXPORTED_SYMBOLS = ["DirIndex", "LoadDirIndex"];
