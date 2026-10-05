// Relationships for the owned rooms; all measurements use the shared atomic geometry helper.
export const polishRoomSpecs={
 community:{roots:['#page-community:not([hidden])','.community-dialog[open]'],largeTargets:'.community-post-open',
  leftEdges:[['#community-forum .hero-label','#community-posts'],['#community-chat-form>label','#community-chat-body']],
  centers:[{parent:'.chat-topline',children:':scope>div,:scope>button',wrap:true},{parent:'.chat-compose-footer',children:':scope>p,:scope>button',wrap:true},{parent:'.field-caption',children:':scope>span,:scope>.copy-help',wrap:true}],
  helpRows:['.copy-caption'],helpContexts:['#page-community [data-copy-help]','.community-dialog[open] [data-copy-help]'],buttonRows:[{parent:'.community-toolbar-actions'},{parent:'.community-dialog .modal-actions'}],
  repeatedPadding:['.community-post:not(.is-focal) .community-post-open'],repeatedGaps:['.community-meta'],bottomReserve:[{content:'#main-content',controls:'#control-strip:not([hidden]),.mobile-nav'}]},
 members:{roots:['#page-users:not([hidden])','#invites-dialog[open]','#password-dialog[open]'],largeTargets:'.user-row',
  controls:'button,input:not([type=checkbox]),select,summary',
  leftEdges:[['.permission-heading','.permissions','.total-limit']],
  centers:[{parent:'.permission-top',children:':scope>input,:scope>.permission-name,:scope>.permission-spec',wrap:true},{parent:'.copy-caption',children:':scope>h3,:scope>label,:scope>span:not(.copy-help),:scope>.copy-help',wrap:true}],
  helpRows:['.permission-heading .copy-caption','.total-limit .copy-caption','.invite-heading .copy-caption'],helpContexts:['#page-users [data-copy-help]','#invites-dialog[open] [data-copy-help]','#password-dialog[open] [data-copy-help]'],
  buttonRows:[{parent:'.editor-save>div:last-child'},{parent:'.account-actions',children:'.button'},{parent:'.invite-actions'}],
  repeatedPadding:['.permission'],repeatedRowHeights:['.permission-top'],bottomReserve:[{content:'#main-content',controls:'#control-strip:not([hidden]),.mobile-nav'}]},
 cloud:{roots:['#cloud-files'],controls:'button,input,summary',largeTargets:'summary',
  leftEdges:[['#cloud-files-form .field-caption','#cloud-files-form input','#cloud-files-form .file-actions']],
  centers:[{parent:'.cloud-file-heading',children:':scope>code,:scope>.st',wrap:true},{parent:'#cloud-files .field-caption',children:':scope>span,:scope>.copy-help',wrap:true}],helpContexts:['#cloud-files [data-copy-help]'],
  buttonRows:[{parent:'#cloud-files .file-actions'}],repeatedPadding:['#cloud-files-list>li'],
  containment:'input,button,summary,.cloud-file-heading,.cloud-file-details>code,.field-caption'}
};
