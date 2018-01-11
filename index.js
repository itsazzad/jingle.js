var util = require('util');
var intersect = require('intersect');
var WildEmitter = require('wildemitter');

var BaseSession = require('jingle-session');
var MediaSession = require('jingle-media-session');
var FileSession = require('jingle-filetransfer-session');

var transform = require('sdp-transform');
var sjj = require('sdp-jingle-json');


function SessionManager(conf) {
    WildEmitter.call(this);

    conf = conf || {};

    this.jid = conf.jid;
    this.selfID = conf.selfID || (this.jid && this.jid.full) || this.jid || '';

    this.sessions = {};
    this.peers = {};
    this.useJingle = true;

    this.prepareSession = conf.prepareSession || function (opts) {
        if (opts.applicationTypes.indexOf('rtp') >= 0) {
            return new MediaSession(opts);
        }
        if (opts.applicationTypes.indexOf('filetransfer') >= 0) {
            return new FileSession(opts);
        }
    };

    this.performTieBreak = conf.performTieBreak || function (sess, req) {
        var applicationTypes= req.jingle.contents.map(function (content) {
            if (content.application) {
                return content.application.applicationType;
            }
        });

        var matching = intersect(sess.pendingApplicationTypes, applicationTypes);

        return matching.length > 0;
    };

    this.config = {
        debug: false,
        peerConnectionConfig: {
            iceServers: conf.iceServers || [{'urls': 'stun:stun.l.google.com:19302'}]
        },
        peerConnectionConstraints: {
            optional: [
                {DtlsSrtpKeyAgreement: true},
                {RtpDataChannels: false}
            ]
        },
        media: {
            audio: true,
            video: true
        }
    };

    for (var item in conf) {
        this.config[item] = conf[item];
    }

    this.iceServers = this.config.peerConnectionConfig.iceServers;
}


util.inherits(SessionManager, WildEmitter);


SessionManager.prototype.addICEServer = function (server) {
    // server == {
    //    url: '',
    //    [username: '',]
    //    [credential: '']
    // }
    if (typeof server === 'string') {
        server = {urls: server};
    }
    this.iceServers.push(server);
};

SessionManager.prototype.addSession = function (session) {
    var self = this;

    var sid = session.sid;
    var peer = session.peerID;

    this.sessions[sid] = session;
    if (!this.peers[peer]) {
        this.peers[peer] = [];
    }

    this.peers[peer].push(session);

    // Automatically clean up tracked sessions
    session.on('terminated', function () {
        var peers = self.peers[peer] || [];
        if (peers.length) {
            peers.splice(peers.indexOf(session), 1);
        }
        delete self.sessions[sid];
    });

    // Proxy session events
    session.on('*', function (name, data, extraData, extraData2) {
        // Listen for when we actually try to start a session to
        // trigger the outgoing event.
        if (name === 'send') {
            var action = data.jingle && data.jingle.action;
            if (session.isInitiator && action === 'session-initiate') {
                self.emit('outgoing', session);
            }
        }

        if (self.config.debug && (name === 'log:debug' || name === 'log:error')) {
            console.log('Jingle:', data, extraData, extraData2);
        }

        // Don't proxy change:* events, since those don't apply to
        // the session manager itself.
        if (name.indexOf('change') === 0) {
            return;
        }

        self.emit(name, data, extraData, extraData2);
    });

    this.emit('createdSession', session);

    return session;
};

SessionManager.prototype.createMediaSession = function (peer, sid, stream) {
    let peerJID;
    let useJingle;
    if (peer !== null && typeof peer === 'object') {
        peerJID = peer.jid;
        useJingle = peer.useJingle;
        this.useJingle = peer.useJingle;
    } else {
        peerJID = peer;
        useJingle = true;
        this.useJingle = true;
    }
    var session = new MediaSession({
        sid: sid,
        peer: peerJID,
        initiator: true,
        stream: stream,
        parent: this,
        iceServers: this.iceServers,
        constraints: this.config.peerConnectionConstraints,
        useJingle,
    });

    this.addSession(session);

    return session;
};

SessionManager.prototype.createFileTransferSession = function (peer, sid) {
    var session = new FileSession({
        sid: sid,
        peer: peer,
        initiator: true,
        parent: this,
        iceServers: this.iceServers
    });

    this.addSession(session);

    return session;
};

SessionManager.prototype.endPeerSessions = function (peer, reason, silent) {
    peer = peer.full || peer;

    var sessions = this.peers[peer] || [];
    delete this.peers[peer];

    sessions.forEach(function (session) {
        session.end(reason || 'gone', silent);
    });
};

SessionManager.prototype.endAllSessions = function (reason, silent) {
    var self = this;
    Object.keys(this.peers).forEach(function (peer) {
        self.endPeerSessions(peer, reason, silent);
    });
};

SessionManager.prototype._createIncomingSession = function (meta, req) {
    var session;

    if (this.prepareSession) {
        session = this.prepareSession(meta, req);
    }

    // Fallback to a generic session type, which can
    // only be used to end the session.

    if (!session) {
        session = new BaseSession(meta);
    }

    this.addSession(session);

    return session;
};

SessionManager.prototype._sendError = function (to, id, data) {
    if (!data.type) {
        data.type = 'cancel';
    }
    this.emit('send', {
        to: to,
        id: id,
        type: 'error',
        error: data
    });
};

SessionManager.prototype._log = function (level, message) {
    this.emit('log:' + level, message);
};

SessionManager.prototype.process = function (req) {
    console.error('XXX1', req);
    var self = this;
    if(req.signal){
        this.useJingle = false;
        self.useJingle = false;
    }

    // Extract the request metadata that we need to verify
    var sid = !!req.jingle ? req.jingle.sid : null;
    var session = this.sessions[sid] || null;
    var rid = req.id;
    var sender = req.from.full || req.from;


    if (req.type === 'error') {
        var isTieBreak = req.error && req.error.jingleCondition === 'tie-break';
        if (session && session.pending && isTieBreak) {
            return session.end('alternative-session', true);
        } else {
            if (session) {
                session.pendingAction = false;
            }
            return this.emit('error', req);
        }
    }

    if (req.type === 'result') {
        if (session) {
            session.pendingAction = false;
        }
        return;
    }

    var action = (req.signal && req.signal.action) ? BaseSession.prototype.mappedActions(req.signal.action) : req.jingle.action;
    if(req.signal && req.signal.sdp){
        var sdp = window.atob(req.signal.sdp);
        console.error('XXX2', sdp);
        var res = transform.parse(sdp);
        console.error('XXX3', res);

        sdp = 'v=0\n' +
        'o=- 198146714528068009 2 IN IP4 127.0.0.1\n' +
        's=-\n' +
        't=0 0\n' +
        'a=group:BUNDLE audio video\n' +
        'a=msid-semantic: WMS ARDAMS\n' +
        'm=audio 9 UDP/TLS/RTP/SAVPF 111 103 104 9 102 0 8 106 105 13 110 112 113 126\n' +
        'c=IN IP4 0.0.0.0\n' +
        'a=rtcp:9 IN IP4 0.0.0.0\n' +
        'a=ice-ufrag:K2r7\n' +
        'a=ice-pwd:KAV1zCFQyD8xG3o2unjasypn\n' +
        'a=ice-options:trickle renomination\n' +
        'a=fingerprint:sha-256 91:16:1A:7F:BC:20:2A:45:DB:B3:43:68:8A:A0:70:4A:63:DD:4C:A4:BA:C8:D0:A0:F4:C9:08:50:DA:CE:63:05\n' +
        'a=setup:actpass\n' +
        'a=mid:audio\n' +
        'a=sendrecv\n' +
        'a=rtcp-mux\n' +
        'a=rtpmap:111 opus/48000/2\n' +
        'a=fmtp:111 minptime=10;useinbandfec=1\n' +
        'a=rtpmap:103 ISAC/16000\n' +
        'a=rtpmap:104 ISAC/32000\n' +
        'a=rtpmap:9 G722/8000\n' +
        'a=rtpmap:102 ILBC/8000\n' +
        'a=rtpmap:0 PCMU/8000\n' +
        'a=rtpmap:8 PCMA/8000\n' +
        'a=rtpmap:106 CN/32000\n' +
        'a=rtpmap:105 CN/16000\n' +
        'a=rtpmap:13 CN/8000\n' +
        'a=rtpmap:110 telephone-event/48000\n' +
        'a=rtpmap:112 telephone-event/32000\n' +
        'a=rtpmap:113 telephone-event/16000\n' +
        'a=rtpmap:126 telephone-event/8000\n' +
        'a=ssrc:3739837625 cname:svf+DhFNLSgc4cQT\n' +
        'a=ssrc:3739837625 msid:ARDAMS ARDAMSa0\n' +
        'a=ssrc:3739837625 mslabel:ARDAMS\n' +
        'a=ssrc:3739837625 label:ARDAMSa0\n' +
        'm=video 9 UDP/TLS/RTP/SAVPF 96 98 100 127 97 99 101\n' +
        'c=IN IP4 0.0.0.0\n' +
        'a=rtcp:9 IN IP4 0.0.0.0\n' +
        'a=ice-ufrag:K2r7\n' +
        'a=ice-pwd:KAV1zCFQyD8xG3o2unjasypn\n' +
        'a=ice-options:trickle renomination\n' +
        'a=fingerprint:sha-256 91:16:1A:7F:BC:20:2A:45:DB:B3:43:68:8A:A0:70:4A:63:DD:4C:A4:BA:C8:D0:A0:F4:C9:08:50:DA:CE:63:05\n' +
        'a=setup:actpass\n' +
        'a=mid:video\n' +
        'a=sendrecv\n' +
        'a=rtcp-mux\n' +
        'a=rtcp-rsize\n' +
        'a=rtpmap:96 VP8/90000\n' +
        'a=rtpmap:98 VP9/90000\n' +
        'a=rtpmap:100 red/90000\n' +
        'a=rtpmap:127 ulpfec/90000\n' +
        'a=rtpmap:97 rtx/90000\n' +
        'a=fmtp:97 apt=96\n' +
        'a=rtpmap:99 rtx/90000\n' +
        'a=fmtp:99 apt=98\n' +
        'a=rtpmap:101 rtx/90000\n' +
        'a=fmtp:101 apt=100\n' +
        'a=ssrc-group:FID 299990220 2484813461\n' +
        'a=ssrc:299990220 cname:svf+DhFNLSgc4cQT\n' +
        'a=ssrc:299990220 msid:ARDAMS ARDAMSv0\n' +
        'a=ssrc:299990220 mslabel:ARDAMS\n' +
        'a=ssrc:299990220 label:ARDAMSv0\n' +
        'a=ssrc:2484813461 cname:svf+DhFNLSgc4cQT\n' +
        'a=ssrc:2484813461 msid:ARDAMS ARDAMSv0\n' +
        'a=ssrc:2484813461 mslabel:ARDAMS\n' +
        'a=ssrc:2484813461 label:ARDAMSv0';
        var signal = sjj.toSessionJSON(sdp, {
            creators: ['initiator'], // Who created the media contents
            role: 'responder',   // Which side of the offer/answer are we acting as
            direction: 'incoming' // Are we parsing SDP that we are sending or receiving?
        });
        console.error('XXX4', signal);
    }
    var contents = (signal ? signal.contents : req.jingle.contents) || [];

    var applicationTypes = contents.map(function (content) {
        if (content.application) {
            return content.application.applicationType;
        }
    });
    var transportTypes = contents.map(function (content) {
        if (content.transport) {
            return content.transport.transportType;
        }
    });


    // Now verify that we are allowed to actually process the
    // requested action

    if (action !== 'session-initiate') {
        // Can't modify a session that we don't have.
        if (!session) {
            this._log('error', 'Unknown session', sid);
            return this._sendError(sender, rid, {
                condition: 'item-not-found',
                jingleCondition: 'unknown-session'
            });
        }

        // Check if someone is trying to hijack a session.
        if (session.peerID !== sender || session.ended) {
            this._log('error', 'Session has ended, or action has wrong sender');
            return this._sendError(sender, rid, {
                condition: 'item-not-found',
                jingleCondition: 'unknown-session'
            });
        }

        // Can't accept a session twice
        if (action === 'session-accept' && !session.pending) {
            this._log('error', 'Tried to accept session twice', sid);
            return this._sendError(sender, rid, {
                condition: 'unexpected-request',
                jingleCondition: 'out-of-order'
            });
        }

        // Can't process two requests at once, need to tie break
        if (action !== 'session-terminate' && action === session.pendingAction) {
            this._log('error', 'Tie break during pending request');
            if (session.isInitiator) {
                return this._sendError(sender, rid, {
                    condition: 'conflict',
                    jingleCondition: 'tie-break'
                });
            }
        }
    } else if (session) {
        // Don't accept a new session if we already have one.
        if (session.peerID !== sender) {
            this._log('error', 'Duplicate sid from new sender');
            return this._sendError(sender, rid, {
                condition: 'service-unavailable'
            });
        }

        // Check if we need to have a tie breaker because both parties
        // happened to pick the same random sid.
        if (session.pending) {
            if (this.selfID > session.peerID && this.performTieBreak(session, req)) {
                this._log('error', 'Tie break new session because of duplicate sids');
                return this._sendError(sender, rid, {
                    condition: 'conflict',
                    jingleCondition: 'tie-break'
                });
            }
        } else {
            // The other side is just doing it wrong.
            this._log('error', 'Someone is doing this wrong');
            return this._sendError(sender, rid, {
                condition: 'unexpected-request',
                jingleCondition: 'out-of-order'
            });
        }
    } else if (this.peers[sender] && this.peers[sender].length) {
        // Check if we need to have a tie breaker because we already have
        // a different session with this peer that is using the requested
        // content application types.
        for (var i = 0, len = this.peers[sender].length; i < len; i++) {
            var sess = this.peers[sender][i];
            if (sess && sess.pending && sess.sid > sid && this.performTieBreak(sess, req)) {
                this._log('info', 'Tie break session-initiate');
                return this._sendError(sender, rid, {
                    condition: 'conflict',
                    jingleCondition: 'tie-break'
                });
            }
        }
    }

    // We've now weeded out invalid requests, so we can process the action now.

    if (action === 'session-initiate') {
        if (!contents.length) {
            return self._sendError(sender, rid, {
                condition: 'bad-request'
            });
        }

        session = this._createIncomingSession({
            sid: sid,
            peer: req.from,
            peerID: sender,
            initiator: false,
            parent: this,
            applicationTypes: applicationTypes,
            transportTypes: transportTypes,
            iceServers: this.iceServers,
            constraints: this.config.peerConnectionConstraints
        }, req);
    }

    session.process(action, req.jingle, function (err) {
        if (err) {
            self._log('error', 'Could not process request', req, err);
            self._sendError(sender, rid, err);
        } else {
            self.emit('send', {
                to: sender,
                id: rid,
                type: 'result',
            });

            // Wait for the initial action to be processed before emitting
            // the session for the user to accept/reject.
            if (action === 'session-initiate') {
                self.emit('incoming', session);
            }
        }
    });
};


module.exports = SessionManager;
