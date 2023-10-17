const axios = require('axios');//.default;

const wrapper = {
	axios: axios.create({
		baseURL: 'http://153.le-pv.com:8082/',
		timeout: 5000,
		headers: {
			'Content-Type': 'application/json',
		},
	}),
	url : String(null),
	token : String(null),
	email : String(null),
	password : String(null),
};

wrapper.axios.interceptors.response.use(async (response) => {
	//console.log('==== interceptor ====');
	//console.log(response.data.code);

	if(response.data.code != 1){
		const error = { code: response.data.code, message: `Code does not have the expected value. Aborted!` };
		return Promise.reject(error);
	}
	return response;

}, function (error) {
	return Promise.reject(error);
});

module.exports = wrapper;