var request = require('request')
  , qs = require('querystring')
  , fs = require('fs')
  , logger = require('../lib/logging').logger
  , url = require('url')
  , configuration = require('../lib/configuration')
  , baker = require('../lib/baker')
  , remote = require('../lib/remote')
  , browserid = require('../lib/browserid')
  , awardBadge = require('../lib/award')
  , reverse = require('../lib/router').reverse
  , Badge = require('../models/badge')
  , Collection = require('../models/collection')

exports.param = {};

/**
 * Route param pre-condition for finding a badge when a badgeId is present.
 * If the badge cannot be found, immediately return HTTP 404.
 *
 * @param {String} hash is the `body_hash` of the badge to look up.
 */

exports.param['badgeId'] = function(req, res, next, hash) {
  Badge.findOne({body_hash: hash}, function(err, badge) {
    if (!badge) return res.send('could not find badge', 404);
    req.badge = badge;
    return next();
  });
};


/**
 * Render the login page.
 */

exports.login = function(req, res) {
  // req.flash returns an array. Pass on the whole thing to the view and
  // decide there if we want to display all of them or just the first one.
  res.render('login', {
    error: req.flash('error'),
    csrfToken: req.session._csrf
  });
};


/**
 * Authenticate the user using a browserID assertion.
 *
 * @param {String} assertion returned by `navigator.id.getVerifiedEmail`
 * @return {HTTP 303}
 *   on error: redirect one page back
 *   on success: redirect to `backpack.manage`
 */

exports.authenticate = function(req, res) {
  if (!req.body || !req.body['assertion']) {
    return res.redirect(reverse('backpack.login'), 303);
  }

  var ident = configuration.get('identity')
    , uri = ident.protocol + '://' +  ident.server + ident.path
    , assertion = req.body['assertion']
    , audience = configuration.get('hostname');
  
  browserid(uri, assertion, audience, function (err, verifierResponse) {
    if (err) {
      logger.error('Failed browserID verification: ')
      logger.debug('Type: ' + err.type + "; Body: " + err.body);
      req.flash('error', "Could not verify with browserID!");
      return res.redirect('back', 303);
    }
    
    if (!req.session) res.session = {};
    
    if (!req.session.emails) req.session.emails = []
    
    logger.debug('browserid verified, attempting to authenticate user');
    req.session.emails.push(verifierResponse.email);
    return res.redirect(reverse('backpack.manage'), 303);
  });
};


/**
 * Wipe the user's session and send back to the login page.
 *
 * @return {HTTP 303} redirect user to login page
 */

exports.signout = function(req, res) {
  req.session = {};
  res.redirect(reverse('backpack.login'), 303);
};


/**
 * Render the management page for logged in users.
 *
 * @return {HTTP 303} redirect user to login page
 */

exports.manage = function(req, res, next) {
  var user = req.user
    , error = req.flash('error')
    , success = req.flash('success')
    , collections = []
    , badgeIndex = {};
  if (!user) return res.redirect(reverse('backpack.login'), 303);
  
  var prepareBadges = function (badges) {
    badges.forEach(function (badge) {
      badgeIndex[badge.data.id] = badge;
      badge.detailsUrl = reverse('backpack.details', { badgeId: badge.data.body_hash });
    })
  };
  var modifyCollections = function (collections) {
    collections.forEach(function (collection) {
      collection.url = collection.data.url;
      collection.data.badges = (collection.data.badges || []);
      collection.data.badgeObjs = [];
      collection.data.badges.forEach(function (badgeId) {
        var badge = badgeIndex[badgeId];
        if (badge) collection.data.badgeObjs.push(badge);
      });
      collection.data.badges = collection.data.badgeObjs.map(function (b) { return b.data.id });
    })
  };
  var getCollections = function () {
    Collection.find({user_id: user.data.id}, getBadges);
  };
  var getBadges = function (err, data) {
    if (err) return next(err);
    collections = data;
    Badge.find({email: user.data.email}, makeResponse)
  };
  var makeResponse = function (err, badges) {
    if (err) return next(err);
    prepareBadges(badges);
    modifyCollections(collections);
    res.render('manage', {
      error: error,
      success: success,
      badges: badges,
      csrfToken: req.session._csrf,
      groups: collections
    })
  };
  var startResponse = getCollections;
  return startResponse();
};


/**
 * Render a badge details page.
 */

exports.details = function(req, res) {
  var badge = req.badge
    , user = req.user
    , email = user ? user.data.email : null
    , assertion = badge.data.body;
  
  res.render('badge-details', {
    title: '',
    user: (assertion.recipient === email) ? email : null,
    
    id: badge.data.id,
    recipient: assertion.recipient,
    image: badge.data.image_path,
    owner: (assertion.recipient === email),
    
    deleteRoute: reverse('backpack.deleteBadge', { badgeId: badge.data.body_hash }),
    csrfToken: req.session._csrf,
    
    badge: badge,
    type: assertion.badge,
    meta: {}, // #TODO: remove.
    groups: [] // #TODO: replace with real grouping
  })
}


/**
 * Completely delete a badge from the user's account.
 *
 * @return {HTTP 500|403|303}
 *   user doesn't own the badge -> 403.
 *   error calling `Badge#destroy` -> 500
 *   success -> 303 to `backpack.manage`
 */

exports.deleteBadge = function (req, res) {
  var badge = req.badge
    , user = req.user
    , assertion = badge.data.body
    , failNow = function () { return res.send("Cannot delete a badge you don't own", 403) }
  if (!user) return failNow()
  
  if (assertion.recipient !== user.data.email) return failNow()
  
  badge.destroy(function (err, badge) {
    if (err) {
      logger.warn('Failed to delete badge');
      logger.warn(err);
      return res.send('Could not delete badge. This error has been logged', 500);
    }
    return res.redirect(reverse('backpack.manage'), 303);
  })
};


/**
 * Handle upload of a badge from a user's filesystem. Gets embedded data from
 * uploaded PNG with `urlFromUpload` from lib/baker, retrieves the assertion
 * using `getHostedAssertion` from lib/remote and finally awards the badge
 * using `award` from lib/award.
 *
 * @param {File} userBadge uploaded badge from user (from request)
 * @return {HTTP 303} redirects to manage (with error, if necessary)
 */

exports.userBadgeUpload = function(req, res) {
  var user = req.user
    , tmpfile = req.files.userBadge;
  
  // go back to the manage page and potentially show an error
  var redirect = function(err) {
    if (err) {
      logger.warn('There was an error uploading a badge');
      logger.debug(err);
      req.flash('error', err.message);
    }
    return res.redirect(reverse('backpack.manage'), 303);
  }
  
  if (!user) return res.redirect(reverse('backpack.login'), 303);
  
  if (!tmpfile.size) return redirect(new Error('You must choose a badge to upload.'));
  
  // get the url from the uploaded badge file
  baker.urlFromUpload(tmpfile, function (err, assertionUrl, imagedata) {
    if (err) return redirect(err);
    
    // grab the assertion data from the endpoint
    remote.getHostedAssertion(assertionUrl, function (err, assertion) {
      if (err) return redirect(err);

      // bail if the badge wasn't issued to the logged in user
      if (assertion.recipient !== user.data.email) {
        err = new Error('This badge was not issued to you! Contact your issuer.');
        err.name = 'InvalidRecipient';
        return redirect(err);
      }
      
      // try to issue the badge 
      awardBadge(assertion, assertionUrl, imagedata, function(err, badge) {
        if (err) {
          logger.warn('Could not save an uploaded badge: ');
          logger.debug(err);
          return redirect(new Error('There was a problem saving your badge!'));
        }
        return redirect();
      });
    });
  });
};
