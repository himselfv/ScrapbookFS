
var sbNoteService = {

    get TEXTBOX()   { return document.getElementById("sbNoteTextbox"); },

    resource : null,
    changed  : false,
    locked   : false,
    initFlag : false,
    sidebarContext : true,

    create : function(aTarResURI, aTarRelIdx, aForceTabbed) {
        if ( this.locked ) return;
        this.locked = true;
        setTimeout(function(){ sbNoteService.locked = false; }, 1000);
        this.save();
        var newItem = sbCommonUtils.newItem(sbCommonUtils.getTimeStamp());
        newItem.id    = sbDataSource.identify(newItem.id);
        newItem.type  = "note";
        newItem.chars = "UTF-8";
        this.resource = sbDataSource.addItem(newItem, aTarResURI, aTarRelIdx);
        if ( !("gBrowser" in window.top) ) aForceTabbed = true;
        (sbCommonUtils.getPref("tabs.note", false) || aForceTabbed) ? this.open(this.resource, true) : this.edit(this.resource);
    },

    edit : function(aRes) {
        if ( !this.initFlag ) {
            this.initFlag = true;
            this.TEXTBOX.addEventListener("dragdrop", function(){ sbNoteService.change(true); }, true);
        }
        if ( !sbDataSource.exists(aRes) ) return;
        this.save();
        this.resource = aRes;
        this.changed = false;
        if ( this.sidebarContext ) {
            document.getElementById("sbNoteSplitter").hidden = false;
            document.getElementById("sbNoteOuter").hidden = false;
        }
        this.TEXTBOX.value = "";
        this.TEXTBOX.value = sbDataSource.readNoteContents(this.resource);
        this.TEXTBOX.mInputField.focus();
        try { this.TEXTBOX.editor.transactionManager.clear(); } catch(ex) {}
        document.getElementById("sbNoteLabel").value = sbDataSource.getProperty(this.resource, "title");
        if ( !this.sidebarContext ) setTimeout(function(){ sbNoteService2.refreshTab(); }, 0);
    },

    save : function() {
        if ( !this.changed ) return;
        if ( !sbDataSource.exists(this.resource) ) return;
        sbDataSource.writeNoteContents(this.resource, this.TEXTBOX.value);
        this.saveResource();
        this.change(false);
    },

    saveResource : function() {
        var title = sbCommonUtils.crop(sbCommonUtils.crop(this.TEXTBOX.value.split("\n")[0].replace(/\t/g, " "), 180, true), 150);
        sbDataSource.setProperty(this.resource, "title", title);
    },

    exit : function() {
        this.save();
        this.resource  = null;
        this.change(false);
        if ( this.sidebarContext ) {
            document.getElementById("sbNoteSplitter").hidden = true;
            document.getElementById("sbNoteOuter").hidden = true;
        }
    },

    open : function(aRes, aTabbed) {
        if ( !("gBrowser" in window.top) ) aTabbed = true;
        if ( !aTabbed && window.top.content.sbNoteService ) {
            window.top.content.sbNoteService.edit(aRes);
        } else {
            if ( aTabbed ) {
                sbCommonUtils.loadURL("chrome://scrapbook/content/note.xul?id=" + sbDataSource.getProperty(aRes, "id"), aTabbed);
            } else {
                sbNoteService.edit(aRes);
            }
        }
    },

    expand : function() {
        this.open(this.resource, true);
        this.exit();
    },

    change : function(aBool) {
        this.changed = aBool;
        if ( !this.sidebarContext ) document.getElementById("sbNoteToolbarS").disabled = !aBool;
    },

    insertString : function(aEvent) {
        if ( aEvent.keyCode == aEvent.DOM_VK_ESCAPE && this.sidebarContext ) { sbNoteService.exit(); return; }
        if ( aEvent.ctrlKey || aEvent.altKey || aEvent.shiftKey ) return;
        var str = "";
        switch ( aEvent.keyCode ) {
            case aEvent.DOM_VK_TAB : str = "\t"; break;
            case aEvent.DOM_VK_F5  : str = (new Date()).toLocaleString(); break;
            default : return;
        }
        aEvent.preventDefault();
        var command = "cmd_insertText";
        try {
            var controller = document.commandDispatcher.getControllerForCommand(command);
            if ( controller && controller.isCommandEnabled(command) ) {
                controller = controller.QueryInterface(Components.interfaces.nsICommandController);
                var params = Components.classes['@mozilla.org/embedcomp/command-params;1'].createInstance(Components.interfaces.nsICommandParams);
                params.setStringValue("state_data", str);
                controller.doCommandWithParams(command, params);
            }
        } catch(ex) {
        }
    },

};


